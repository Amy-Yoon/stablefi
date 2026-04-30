import { NextRequest } from "next/server";
import {
  createPublicClient,
  http,
  parseAbiItem,
  type Log,
} from "viem";
import { stableNetChain, STABLENET_TESTNET, CONTRACTS } from "@/lib/chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── V3 NFT 포지션별 라이프사이클 히스토리 ─────────────────────────────────
// 진입 시점 + 누적 입금 / 출금 / 수수료 수령을 한 번의 응답으로 묶어서
// 클라이언트 (useMyPositions) 가 effective APR / 누적 수익률 계산에 쓰게 한다.
//
// 입력:
//   ?tokenIds=1,2,3   - 사용자 NFT id들 (콤마 구분)
//   ?clientLatest=N   - RPC stale 우회용 wallet block hint
//   ?debug=1
//
// 출력:
//   { histories: { [tokenId]: { mintTimestamp, mintBlock, ... } } }
//   - 모든 amount 는 raw wei string. token0/token1 decimals 는 클라가 가진
//     PoolState 에서 가져와 환산.
//
// 한 번에 모든 tokenId 의 이벤트를 가져온 뒤 메모리에서 group-by 하므로 NFT 가
// 5~10 개여도 RPC 호출 수는 일정 (chunk 수 × 4 종류 이벤트).

// Lookback — 포지션이 1주일 이상 오래된 케이스도 잡으려면 길게 가야 함.
// chunk 수를 늘리는 만큼 RPC 호출이 비례 증가하지만, 클라가 5분 캐시하므로
// 사용자당 거의 1회만 발생.
const BLOCK_CHUNK = 10_000n;
const CHUNK_COUNT = 100n; // 1M 블록 ≈ 11.5일 — 통상적인 LP 보유 기간을 다 커버.
const TOTAL_LOOKBACK = BLOCK_CHUNK * CHUNK_COUNT;
const BLOCK_PROBE_ATTEMPTS = 3;
const MAX_CLIENT_HINT_LEAD = 1_000_000n;

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
);
const increaseLiquidityEvent = parseAbiItem(
  "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
);
const decreaseLiquidityEvent = parseAbiItem(
  "event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
);
const collectEvent = parseAbiItem(
  "event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)",
);

function makeServerClient() {
  return createPublicClient({
    chain: stableNetChain,
    transport: http(STABLENET_TESTNET.rpcUrl, {
      batch: { batchSize: 64, wait: 16 },
      retryCount: 2,
      retryDelay: 400,
    }),
  });
}

async function scanChunked(
  fetcher: (start: bigint, end: bigint) => Promise<Log[]>,
  from: bigint,
  to: bigint,
): Promise<Log[]> {
  const ranges: Array<[bigint, bigint]> = [];
  for (let s = from; s <= to; s += BLOCK_CHUNK) {
    const e = s + BLOCK_CHUNK - 1n > to ? to : s + BLOCK_CHUNK - 1n;
    ranges.push([s, e]);
  }
  const results = await Promise.all(
    ranges.map(async ([s, e]) => {
      try {
        return await fetcher(s, e);
      } catch {
        try {
          return await fetcher(s, e);
        } catch {
          return [] as Log[];
        }
      }
    }),
  );
  return results.flat();
}

interface PositionHistory {
  /** 가장 첫 mint 시점 (Transfer from 0x0 → owner). lookback 범위 안에 있어야 잡힘. */
  mintBlock?: string;
  mintTimestamp?: string;
  /** 누적 입금 (mint + 후속 increaseLiquidity 합산), raw wei string */
  grossDeposit0Raw: string;
  grossDeposit1Raw: string;
  /** 누적 출금 (decreaseLiquidity 합산) */
  grossWithdraw0Raw: string;
  grossWithdraw1Raw: string;
  /** 누적 collect (실현된 수수료 — 받아간 건 이미 사용자 지갑에 있음) */
  collected0Raw: string;
  collected1Raw: string;
  /** 디버깅용 — 이벤트 개수 */
  eventCount: {
    transfer: number;
    increase: number;
    decrease: number;
    collect: number;
  };
}

const ZERO_HISTORY = (): PositionHistory => ({
  mintBlock: undefined,
  mintTimestamp: undefined,
  grossDeposit0Raw: "0",
  grossDeposit1Raw: "0",
  grossWithdraw0Raw: "0",
  grossWithdraw1Raw: "0",
  collected0Raw: "0",
  collected1Raw: "0",
  eventCount: { transfer: 0, increase: 0, decrease: 0, collect: 0 },
});

export async function GET(req: NextRequest) {
  const tokenIdsRaw = req.nextUrl.searchParams.get("tokenIds") ?? "";
  const debug = req.nextUrl.searchParams.get("debug") === "1";
  const clientLatestRaw = req.nextUrl.searchParams.get("clientLatest") ?? "";
  const clientLatestHint =
    clientLatestRaw && /^\d+$/.test(clientLatestRaw)
      ? BigInt(clientLatestRaw)
      : 0n;

  const tokenIds: bigint[] = [];
  for (const part of tokenIdsRaw.split(",").filter(Boolean)) {
    if (!/^\d+$/.test(part)) continue;
    try {
      tokenIds.push(BigInt(part));
    } catch {
      // skip
    }
  }

  if (tokenIds.length === 0) {
    return Response.json({ histories: {} }, { status: 200 });
  }

  const client = makeServerClient();

  // probe-max — 활동 API 와 동일 패턴 (StableNet RPC stale 우회).
  const probes = await Promise.all(
    Array.from({ length: BLOCK_PROBE_ATTEMPTS }, () =>
      client.getBlockNumber({ cacheTime: 0 }).catch(() => null as bigint | null),
    ),
  );
  const valid = probes.filter((v): v is bigint => v !== null);
  if (valid.length === 0) {
    return Response.json(
      { histories: {}, error: "rpc-unreachable" },
      { status: 200 },
    );
  }
  const serverLatest = valid.reduce((a, b) => (a > b ? a : b));
  const hintAccepted =
    clientLatestHint > serverLatest &&
    clientLatestHint - serverLatest <= MAX_CLIENT_HINT_LEAD;
  const latest = hintAccepted ? clientLatestHint : serverLatest;
  const fromBlock = latest > TOTAL_LOOKBACK ? latest - TOTAL_LOOKBACK : 0n;

  const histories: Record<string, PositionHistory> = {};
  for (const id of tokenIds) histories[id.toString()] = ZERO_HISTORY();

  // 4 종류 이벤트를 한 번씩만 스캔 (tokenId OR 필터). topic 안에 indexed 라
  // viem 이 자동으로 OR 처리.
  const tokenIdArr = tokenIds; // viem args 가 받음

  const [transferLogs, increaseLogs, decreaseLogs, collectLogs] = await Promise.all([
    scanChunked(
      (s, e) =>
        client.getLogs({
          address: CONTRACTS.v3PositionManager,
          event: transferEvent,
          args: { from: "0x0000000000000000000000000000000000000000", tokenId: tokenIdArr },
          fromBlock: s,
          toBlock: e,
        }) as unknown as Promise<Log[]>,
      fromBlock,
      latest,
    ),
    scanChunked(
      (s, e) =>
        client.getLogs({
          address: CONTRACTS.v3PositionManager,
          event: increaseLiquidityEvent,
          args: { tokenId: tokenIdArr },
          fromBlock: s,
          toBlock: e,
        }) as unknown as Promise<Log[]>,
      fromBlock,
      latest,
    ),
    scanChunked(
      (s, e) =>
        client.getLogs({
          address: CONTRACTS.v3PositionManager,
          event: decreaseLiquidityEvent,
          args: { tokenId: tokenIdArr },
          fromBlock: s,
          toBlock: e,
        }) as unknown as Promise<Log[]>,
      fromBlock,
      latest,
    ),
    scanChunked(
      (s, e) =>
        client.getLogs({
          address: CONTRACTS.v3PositionManager,
          event: collectEvent,
          args: { tokenId: tokenIdArr },
          fromBlock: s,
          toBlock: e,
        }) as unknown as Promise<Log[]>,
      fromBlock,
      latest,
    ),
  ]);

  // mint 블록은 "Transfer from 0x0 → owner" 의 가장 작은 blockNumber. 보통
  // mint tx 한 개라 1건. 이걸로 진입 시각 timestamp 가져올 거.
  const mintBlocks = new Map<string, bigint>(); // tokenId → blockNumber
  for (const log of transferLogs as Array<{
    args?: { tokenId?: bigint };
    blockNumber?: bigint;
  }>) {
    const tid = log.args?.tokenId;
    const bn = log.blockNumber;
    if (typeof tid !== "bigint" || typeof bn !== "bigint") continue;
    const key = tid.toString();
    const prev = mintBlocks.get(key);
    if (prev === undefined || bn < prev) mintBlocks.set(key, bn);
    histories[key].eventCount.transfer++;
  }

  // 입금 합산
  for (const log of increaseLogs as Array<{
    args?: { tokenId?: bigint; amount0?: bigint; amount1?: bigint };
  }>) {
    const tid = log.args?.tokenId;
    if (typeof tid !== "bigint") continue;
    const key = tid.toString();
    const h = histories[key];
    if (!h) continue;
    const a0 = log.args?.amount0 ?? 0n;
    const a1 = log.args?.amount1 ?? 0n;
    h.grossDeposit0Raw = (BigInt(h.grossDeposit0Raw) + a0).toString();
    h.grossDeposit1Raw = (BigInt(h.grossDeposit1Raw) + a1).toString();
    h.eventCount.increase++;
  }

  // 출금 합산
  for (const log of decreaseLogs as Array<{
    args?: { tokenId?: bigint; amount0?: bigint; amount1?: bigint };
  }>) {
    const tid = log.args?.tokenId;
    if (typeof tid !== "bigint") continue;
    const key = tid.toString();
    const h = histories[key];
    if (!h) continue;
    const a0 = log.args?.amount0 ?? 0n;
    const a1 = log.args?.amount1 ?? 0n;
    h.grossWithdraw0Raw = (BigInt(h.grossWithdraw0Raw) + a0).toString();
    h.grossWithdraw1Raw = (BigInt(h.grossWithdraw1Raw) + a1).toString();
    h.eventCount.decrease++;
  }

  // 수수료 수령 합산. 주의: Collect 는 decreaseLiquidity 후 흘려나오는 원금도
  // 같이 받아가는데, 사용자가 wisely 했다면 collect-only 도 따로 있고, 그것의
  // 합이 수수료. 다만 정확한 수수료-vs-원금 분리는 tx 단위 분석이 필요해서
  // 현재는 "decrease 직후 collect" 패턴은 원금 회수, "단독 collect" 는 수수료
  // 라는 단순 가정. 향후 가능하면 (collect.amount0 - decrease.amount0) 식으로
  // 정밀화. 이번 라운드는 collected 합산만 — UI 에선 미수령 + 수령 통합으로
  // 누적 수수료 표기하므로 약간 과대계상 가능성 있음 (출금 시 동시 collect 케이스).
  for (const log of collectLogs as Array<{
    args?: { tokenId?: bigint; amount0?: bigint; amount1?: bigint };
  }>) {
    const tid = log.args?.tokenId;
    if (typeof tid !== "bigint") continue;
    const key = tid.toString();
    const h = histories[key];
    if (!h) continue;
    const a0 = log.args?.amount0 ?? 0n;
    const a1 = log.args?.amount1 ?? 0n;
    h.collected0Raw = (BigInt(h.collected0Raw) + a0).toString();
    h.collected1Raw = (BigInt(h.collected1Raw) + a1).toString();
    h.eventCount.collect++;
  }

  // mint timestamp — 한 번에 unique 블록만 fetch.
  const uniqueMintBlocks = Array.from(new Set(mintBlocks.values()));
  const blockTs = new Map<string, bigint>();
  await Promise.all(
    uniqueMintBlocks.map(async (bn) => {
      try {
        const blk = await client.getBlock({ blockNumber: bn });
        blockTs.set(bn.toString(), blk.timestamp);
      } catch {
        // 한 블록 timestamp 못 가져와도 다른 거에 영향 없음 — 그 포지션의 APR 만 못 구함.
      }
    }),
  );

  for (const [tid, bn] of mintBlocks) {
    histories[tid].mintBlock = bn.toString();
    const ts = blockTs.get(bn.toString());
    if (ts !== undefined) {
      histories[tid].mintTimestamp = ts.toString();
    }
  }

  // 정렬 일관성 — UI 가 history 없는 tokenId 도 ZERO 받게.
  const out: Record<string, PositionHistory> = {};
  for (const id of tokenIds) {
    out[id.toString()] = histories[id.toString()] ?? ZERO_HISTORY();
  }

  return Response.json({
    histories: out,
    ...(debug
      ? {
          debug: {
            fromBlock: fromBlock.toString(),
            toBlock: latest.toString(),
            serverLatestProbes: valid.map((v) => v.toString()),
            clientLatestHint: clientLatestHint.toString(),
            clientHintAccepted: hintAccepted,
            transferLogs: transferLogs.length,
            increaseLogs: increaseLogs.length,
            decreaseLogs: decreaseLogs.length,
            collectLogs: collectLogs.length,
            tokenIdsRequested: tokenIds.length,
          },
        }
      : {}),
  });
}
