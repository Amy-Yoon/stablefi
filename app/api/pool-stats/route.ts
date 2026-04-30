import { NextRequest } from "next/server";
import {
  createPublicClient,
  http,
  parseAbiItem,
  type Log,
} from "viem";
import { stableNetChain, STABLENET_TESTNET } from "@/lib/chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── Pool 24h volume / fee stats via Swap log scan ────────────────────────────
// 풀별 거래량과 누적 수수료를 24h 윈도우로 잘라서 반환한다. 이것을 풀 TVL 로
// 나누면 단순 평균 APR 이 나옴 (공식: fees24h / TVL × 365). UI 는 이걸 받아
// "연 수익률 X%" 한 줄로 표시.
//
// 입력:
//   ?pools=addr:version:feeTier,addr:version:feeTier
//     - version: "v2" | "v3"
//     - feeTier: V3 면 millionths 단위 (3000 = 0.3%), V2 면 무시 (항상 3000)
//   ?clientLatest=<bn>  RPC stale 우회용 wallet block hint (활동 API 와 동일)
//   ?debug=1            진단 정보 같이 내려보냄
//
// 출력:
//   { stats: { [addrLc]: { fee0Raw, fee1Raw, volume0Raw, volume1Raw, swapCount } } }
//   - Raw wei strings 로만 내려보내고, WKRC 환산은 클라이언트가 wkrcPrices 로.
//   - 한 풀이 RPC 실패해도 다른 풀은 살림 (실패 풀은 0 으로 채움).

// 7d @ 1s blocks ≈ 604800. 24h 는 테스트넷처럼 거래량이 변덕스러운 환경에서
// 노이즈 심해서 7일 평균을 디폴트로 잡음 (Uniswap analytics 의 weekly view 와 동일).
// 클라이언트 (usePoolsAggregate) 의 APR 환산식이 365/7 로 곱해지므로 window
// 변경 시 양쪽 모두 맞춰서 수정해야 함.
const BLOCKS_7D = 604_800n;
const LOOKBACK_BUFFER = 20_000n;
const TOTAL_LOOKBACK = BLOCKS_7D + LOOKBACK_BUFFER;

// 활동 API 와 같은 chunk size — 많은 RPC 가 10k 블록 caps 걸어둠.
const BLOCK_CHUNK = 10_000n;
const BLOCK_PROBE_ATTEMPTS = 3;
// 클라 힌트가 서버 tip 보다 너무 멀면 (다른 체인 연결 등) 버림. /api/activity
// 와 동일 정책.
const MAX_CLIENT_HINT_LEAD = 1_000_000n;

const v3SwapEvent = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
);
const v2SwapEvent = parseAbiItem(
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
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
  // 한 번 실패하면 즉시 한 번 더 재시도, 두 번 실패하면 빈 배열로 fall through.
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

interface PoolFee {
  fee0Raw: string; // wei string — 24h fees accrued in token0 wei
  fee1Raw: string; // wei string — 24h fees accrued in token1 wei
  volume0Raw: string; // wei string — 24h input-side volume in token0 wei
  volume1Raw: string; // wei string — 24h input-side volume in token1 wei
  swapCount: number;
}

export async function GET(req: NextRequest) {
  const poolsRaw = req.nextUrl.searchParams.get("pools") ?? "";
  const debug = req.nextUrl.searchParams.get("debug") === "1";
  const clientLatestRaw = req.nextUrl.searchParams.get("clientLatest") ?? "";
  const clientLatestHint =
    clientLatestRaw && /^\d+$/.test(clientLatestRaw)
      ? BigInt(clientLatestRaw)
      : 0n;

  // Parse "addr:version:fee,addr:version:fee"
  const pools: { address: `0x${string}`; version: "v2" | "v3"; fee: number }[] = [];
  for (const part of poolsRaw.split(",").filter(Boolean)) {
    const [addr, ver, feeStr] = part.split(":");
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr ?? "")) continue;
    if (ver !== "v2" && ver !== "v3") continue;
    const fee = parseInt(feeStr ?? "3000", 10);
    if (!Number.isFinite(fee) || fee < 0) continue;
    pools.push({ address: addr as `0x${string}`, version: ver, fee });
  }

  if (pools.length === 0) {
    return Response.json({ stats: {} }, { status: 200 });
  }

  const client = makeServerClient();

  // 활동 API 와 같은 probe-max — 노드 stale 섞여 있을 때 fresh 노드 잡기.
  const probes = await Promise.all(
    Array.from({ length: BLOCK_PROBE_ATTEMPTS }, () =>
      client.getBlockNumber({ cacheTime: 0 }).catch(() => null as bigint | null),
    ),
  );
  const valid = probes.filter((v): v is bigint => v !== null);
  if (valid.length === 0) {
    return Response.json(
      { stats: {}, error: "rpc-unreachable" },
      { status: 200 },
    );
  }
  const serverLatest = valid.reduce((a, b) => (a > b ? a : b));
  const hintAccepted =
    clientLatestHint > serverLatest &&
    clientLatestHint - serverLatest <= MAX_CLIENT_HINT_LEAD;
  const latest = hintAccepted ? clientLatestHint : serverLatest;
  const fromBlock = latest > TOTAL_LOOKBACK ? latest - TOTAL_LOOKBACK : 0n;

  const stats: Record<string, PoolFee> = {};

  await Promise.all(
    pools.map(async (pool) => {
      try {
        if (pool.version === "v3") {
          const logs = await scanChunked(
            (s, e) =>
              client.getLogs({
                address: pool.address,
                event: v3SwapEvent,
                fromBlock: s,
                toBlock: e,
              }) as unknown as Promise<Log[]>,
            fromBlock,
            latest,
          );
          // V3 Swap: amount0/amount1 은 풀 입장에서의 변화량 (signed int256).
          // 양수 = 풀이 받은 쪽 (= 사용자가 입력한 쪽). 수수료는 input 에서 차감되므로
          // 양수 amount × feeTier/1e6 = 해당 토큰으로 누적된 수수료.
          let v0 = 0n;
          let v1 = 0n;
          for (const log of logs as Array<{ args?: { amount0?: bigint; amount1?: bigint } }>) {
            const a0 = log.args?.amount0;
            const a1 = log.args?.amount1;
            if (typeof a0 === "bigint" && a0 > 0n) v0 += a0;
            if (typeof a1 === "bigint" && a1 > 0n) v1 += a1;
          }
          const feeBN = BigInt(pool.fee);
          const f0 = (v0 * feeBN) / 1_000_000n;
          const f1 = (v1 * feeBN) / 1_000_000n;
          stats[pool.address.toLowerCase()] = {
            fee0Raw: f0.toString(),
            fee1Raw: f1.toString(),
            volume0Raw: v0.toString(),
            volume1Raw: v1.toString(),
            swapCount: logs.length,
          };
        } else {
          // V2: amount0In / amount1In 이 input 측 그대로 들어옴. 항상 0.3%.
          const logs = await scanChunked(
            (s, e) =>
              client.getLogs({
                address: pool.address,
                event: v2SwapEvent,
                fromBlock: s,
                toBlock: e,
              }) as unknown as Promise<Log[]>,
            fromBlock,
            latest,
          );
          let v0 = 0n;
          let v1 = 0n;
          for (const log of logs as Array<{
            args?: { amount0In?: bigint; amount1In?: bigint };
          }>) {
            const a0In = log.args?.amount0In;
            const a1In = log.args?.amount1In;
            if (typeof a0In === "bigint") v0 += a0In;
            if (typeof a1In === "bigint") v1 += a1In;
          }
          // V2 fee 항상 0.3% = 3000 millionths.
          const f0 = (v0 * 3000n) / 1_000_000n;
          const f1 = (v1 * 3000n) / 1_000_000n;
          stats[pool.address.toLowerCase()] = {
            fee0Raw: f0.toString(),
            fee1Raw: f1.toString(),
            volume0Raw: v0.toString(),
            volume1Raw: v1.toString(),
            swapCount: logs.length,
          };
        }
      } catch {
        // 한 풀 실패는 다른 풀에 영향 안 주게 — 0 으로 채워서 계속.
        stats[pool.address.toLowerCase()] = {
          fee0Raw: "0",
          fee1Raw: "0",
          volume0Raw: "0",
          volume1Raw: "0",
          swapCount: 0,
        };
      }
    }),
  );

  return Response.json({
    stats,
    ...(debug
      ? {
          debug: {
            fromBlock: fromBlock.toString(),
            toBlock: latest.toString(),
            serverLatestProbes: valid.map((v) => v.toString()),
            clientLatestHint: clientLatestHint.toString(),
            clientHintAccepted: hintAccepted,
            poolCount: pools.length,
          },
        }
      : {}),
  });
}
