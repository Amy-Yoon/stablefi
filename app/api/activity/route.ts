import { NextRequest } from "next/server";
import {
  createPublicClient,
  http,
  parseAbiItem,
  type Log,
  type Abi,
} from "viem";
import { stableNetChain, STABLENET_TESTNET } from "@/lib/chain";
import ERC20Json from "@/lib/abi/ERC20.json";

const ERC20_ABI = ERC20Json as Abi;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── Transaction history via RPC log scan + receipt enrichment ───────────────
// StableNet's explorer is a custom Next.js app with no JSON API — every
// `/api/*` path returns a Next error HTML. So we synthesise history by
// scanning chain logs directly.
//
// Strategy:
//   1) getLogs for ERC20 Transfer where user == from OR user == to
//   2) getLogs for Approval where user == owner (so approve() calls show up —
//      those don't emit Transfer)
//   3) Collect unique txHashes, sort by blockNumber desc, take top N
//   4) For each tx: getTransaction (from/to/value/input)
//                   getTransactionReceipt (status + all Transfer logs)
//      For each unique block: getBlock (timestamp)
//   5) From receipts, extract Transfer movements involving the user so the UI
//      can show "TokenA 100 → TokenB 95" instead of a bare method label.
//
// Coverage tradeoff:
//   • All DeFi activity (swap / deposit / withdraw / approve / send / receive
//     of any ERC20) is captured because every one of those emits Transfer
//     or Approval with the user as an indexed topic.
//   • Pure native-token sends with no ERC20 wrapper are NOT captured —
//     they emit no events. Rare in this app; users can still fall back to
//     the explorer for those.
//   • Failed txs: if the tx reverted before any ERC20 log was emitted, it
//     won't appear. If it reverted AFTER some log (rare — usually all-or-
//     nothing), receipt.status flags it as failed.

const BLOCK_CHUNK = 10_000n;    // conservative per-call range (many RPCs cap here)
const CHUNK_COUNT = 20n;        // 20 × 10k = 200k blocks (~55h @ 1s blocks)
const TOTAL_LOOKBACK = BLOCK_CHUNK * CHUNK_COUNT;
// StableNet 퍼블릭 RPC가 load-balanced 노드 섞여 있어서 eth_blockNumber가
// 랜덤하게 뒤처진 값(수만 블록)을 주는 일이 잦음. 여러 번 찔러서 max를 취하면
// 체인 tip에 가까운 fresh 노드에 최소 한 번은 닿을 확률이 올라감. 3회가
// latency-vs-coverage 밸런스 실측에서 제일 깔끔.
const BLOCK_PROBE_ATTEMPTS = 3;
// clientLatest 힌트는 "서버 RPC가 뒤쳐졌을 때"만 의미가 있음. 서버 tip보다
// 너무 많이 앞서면 지갑이 다른 체인(mainnet 등)에 연결돼 있단 뜻이라 버린다.
// 관측상 StableNet RPC lag worst case가 ~80k 블록이었으므로 10x 여유를 둠.
const MAX_CLIENT_HINT_LEAD = 1_000_000n;

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
const approvalEvent = parseAbiItem(
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
);

// keccak256("Transfer(address,address,uint256)") — identical for ERC20/721
const TRANSFER_TOPIC0 =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// keccak256("Approval(address,address,uint256)") — shared by ERC20 & ERC721.
// Distinguish by topic count: ERC20 has 3 topics (owner, spender) + value in
// data; ERC721 has 4 topics (owner, approved, tokenId all indexed).
const APPROVAL_TOPIC0 =
  "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

// Most "unlimited" approvals are MaxUint256. Some libraries use 2^128-1 or
// similar sentinels, but we only claim "무제한" for the canonical value to
// avoid lying about large-but-finite allowances.
const MAX_UINT256 = (1n << 256n) - 1n;

// Module-level token metadata cache. Safe because symbol/decimals are
// immutable on-chain — no invalidation needed. Survives across requests
// while the Node process is alive.
const TOKEN_META_CACHE = new Map<string, { symbol: string; decimals: number }>();

// Server-side client goes directly to the upstream RPC (no CORS / proxy
// needed because this is Node, not the browser).
function makeServerClient() {
  return createPublicClient({
    chain: stableNetChain,
    transport: http(STABLENET_TESTNET.rpcUrl, {
      batch: { batchSize: 128, wait: 16 },
      retryCount: 2,
      retryDelay: 400,
    }),
  });
}

type TokenMovement = {
  token: `0x${string}`;
  symbol: string;
  decimals: number;
  amount: string;          // wei string
  direction: "in" | "out"; // from user's perspective
  /** The other address on this Transfer (pool / router / recipient). Lets
   *  the UI detect which pool a swap/mint/burn hit by matching KNOWN_POOLS. */
  counterparty: string;
};

// ERC20 approve emits Approval(owner, spender, value) with no Transfer, so
// it never shows up in `movements`. We surface it separately so the UI can
// render "TokenA 승인 · V3 Router 무제한" instead of a bare "승인".
type TokenApproval = {
  token: `0x${string}`;
  symbol: string;
  decimals: number;
  spender: string;        // who was granted allowance (lowercase hex)
  amount: string;         // wei string — compare to MAX_UINT256 for "무제한"
  isUnlimited: boolean;
};

type ExplorerTx = {
  hash: string;
  from: string;
  to: string | null;
  value: string;        // wei string
  timeStamp: string;    // unix seconds string
  blockNumber: string;
  isError: "0" | "1";
  methodId?: string;
  input?: string;
  gasUsed?: string;
  fee?: string;
  movements?: TokenMovement[];
  approvals?: TokenApproval[];
};

type ChunkResult = { logs: Log[]; failed: boolean };

async function scanChunked(
  _client: ReturnType<typeof makeServerClient>,
  from: bigint,
  to: bigint,
  fetcher: (start: bigint, end: bigint) => Promise<Log[]>,
): Promise<{ logs: Log[]; failures: Array<{ from: string; to: string }> }> {
  const ranges: Array<[bigint, bigint]> = [];
  for (let start = from; start <= to; start += BLOCK_CHUNK) {
    const end = start + BLOCK_CHUNK - 1n > to ? to : start + BLOCK_CHUNK - 1n;
    ranges.push([start, end]);
  }
  // 실패한 청크는 즉시 한 번 재시도. 재시도도 실패하면 failures에 기록.
  // (예전에는 조용히 빈 배열을 반환해서 방금 낸 tx가 "가장 최근 청크 실패"로
  //  사라지는 사고가 있었음 — 방금 increaseLiquidity가 안 보이던 이슈.)
  const results = await Promise.all(
    ranges.map(async ([s, e]): Promise<ChunkResult> => {
      try {
        return { logs: await fetcher(s, e), failed: false };
      } catch {
        try {
          return { logs: await fetcher(s, e), failed: false };
        } catch {
          return { logs: [], failed: true };
        }
      }
    }),
  );
  const logs = results.flatMap((r) => r.logs);
  const failures = results
    .map((r, i) => ({ r, s: ranges[i][0], e: ranges[i][1] }))
    .filter(({ r }) => r.failed)
    .map(({ s, e }) => ({ from: s.toString(), to: e.toString() }));
  return { logs, failures };
}

// Pad/slice a 32-byte topic back to a 20-byte address.
function topicToAddress(topic: string | undefined): string {
  if (!topic) return "";
  // topic format: "0x" + 24 zero hex + 40 hex address
  return ("0x" + topic.slice(26)).toLowerCase();
}

async function resolveTokenMeta(
  client: ReturnType<typeof makeServerClient>,
  addresses: string[],
): Promise<void> {
  const uncached = addresses.filter((a) => !TOKEN_META_CACHE.has(a));
  if (uncached.length === 0) return;

  await Promise.all(
    uncached.map(async (addr) => {
      try {
        const [symbol, decimals] = await Promise.all([
          client.readContract({
            address: addr as `0x${string}`,
            abi: ERC20_ABI,
            functionName: "symbol",
          }) as Promise<string>,
          client.readContract({
            address: addr as `0x${string}`,
            abi: ERC20_ABI,
            functionName: "decimals",
          }) as Promise<number>,
        ]);
        TOKEN_META_CACHE.set(addr, {
          symbol: String(symbol),
          decimals: Number(decimals),
        });
      } catch {
        // Unknown contract (non-standard ERC20 or ERC721) — fall back to
        // a short address label and assume 18 decimals so the UI can
        // still render something meaningful.
        TOKEN_META_CACHE.set(addr, {
          symbol: addr.slice(2, 6).toUpperCase(),
          decimals: 18,
        });
      }
    }),
  );
}

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address");
  const debug = req.nextUrl.searchParams.get("debug") === "1";
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return Response.json({ error: "invalid address" }, { status: 400 });
  }
  const limit = Math.min(
    100,
    Math.max(1, parseInt(req.nextUrl.searchParams.get("limit") ?? "50", 10) || 50),
  );
  // 클라이언트가 로컬에 들고 있던 "방금 낸 tx" 해시 목록. 스캐너 RPC가
  // 체인 tip보다 뒤쳐졌을 때, getLogs로는 못 찾지만 eth_getTransactionReceipt
  // 직접 조회로는 찾을 수 있는 경우가 많음. 로그 인덱싱과 receipt 인덱싱은
  // 별개 경로라서 체크포인트 시차가 있기 때문.
  const extraHashesRaw = req.nextUrl.searchParams.get("extraHashes") ?? "";
  const extraHashes = extraHashesRaw
    .split(",")
    .map((h) => h.trim())
    .filter((h) => /^0x[0-9a-fA-F]{64}$/.test(h)) as `0x${string}`[];

  // 클라이언트가 자기 wallet provider에서 읽은 최신 블록 힌트. 서버 RPC가
  // load-balancer 탓에 뒤처진 값을 계속 줄 때 이 힌트로 덮어쓸 수 있음.
  const clientLatestRaw = req.nextUrl.searchParams.get("clientLatest") ?? "";
  const clientLatestHint =
    clientLatestRaw && /^\d+$/.test(clientLatestRaw) ? BigInt(clientLatestRaw) : 0n;

  const user = address as `0x${string}`;
  const userLc = user.toLowerCase();

  const client = makeServerClient();

  // 여러 번 찔러서 max — 뒤처진 노드 섞여있을 때 fresh 노드 잡힐 확률 ↑.
  // cacheTime:0 으로 viem 내부 메모이제이션 무력화.
  const probeAttempts = Array.from({ length: BLOCK_PROBE_ATTEMPTS }, () =>
    client.getBlockNumber({ cacheTime: 0 }).catch(() => null as bigint | null),
  );
  const probed = await Promise.all(probeAttempts);
  const validProbes = probed.filter((v): v is bigint => v !== null);

  if (validProbes.length === 0) {
    return Response.json(
      {
        items: [],
        source: "rpc-error",
        error: "getBlockNumber failed across all probe attempts",
      },
      { status: 200 },
    );
  }

  const serverLatest = validProbes.reduce((a, b) => (a > b ? a : b));
  // 서버 probes max와 클라 힌트 중 큰 쪽을 tip으로 쓴다. 힌트가 서버보다
  // 크면 서버 RPC가 stale한 거라 판단하고 그 위까지 스캔 시도. 단, 힌트가
  // 말이 안 되게 크면 (예: 수백만 블록 차이) 지갑이 다른 체인에 붙어있단
  // 뜻이라 버린다 — 그 상태로 스캔하면 엉뚱한 블록 범위를 뒤져서 내 tx가
  // 전부 범위 밖이 되어 빈 결과가 나옴 (관측된 증상: 지갑 24.9M / 체인 tip
  // 7.25M → hint 채택 시 24.7M~24.9M 스캔해서 결과 0건).
  const hintAccepted =
    clientLatestHint > serverLatest &&
    clientLatestHint - serverLatest <= MAX_CLIENT_HINT_LEAD;
  const latest = hintAccepted ? clientLatestHint : serverLatest;
  const fromBlock = latest > TOTAL_LOOKBACK ? latest - TOTAL_LOOKBACK : 0n;

  // Kick off all three scans in parallel. Each internally chunks by
  // BLOCK_CHUNK to stay under RPC getLogs range caps.
  const [asFrom, asTo, approvalsScan] = await Promise.all([
    scanChunked(client, fromBlock, latest, (s, e) =>
      client.getLogs({
        event: transferEvent,
        args: { from: user },
        fromBlock: s,
        toBlock: e,
      }) as unknown as Promise<Log[]>,
    ),
    scanChunked(client, fromBlock, latest, (s, e) =>
      client.getLogs({
        event: transferEvent,
        args: { to: user },
        fromBlock: s,
        toBlock: e,
      }) as unknown as Promise<Log[]>,
    ),
    scanChunked(client, fromBlock, latest, (s, e) =>
      client.getLogs({
        event: approvalEvent,
        args: { owner: user },
        fromBlock: s,
        toBlock: e,
      }) as unknown as Promise<Log[]>,
    ),
  ]);

  // Dedup by txHash, keep most recent block per tx.
  const byHash = new Map<string, { hash: `0x${string}`; blockNumber: bigint }>();
  for (const log of [...asFrom.logs, ...asTo.logs, ...approvalsScan.logs]) {
    const h = log.transactionHash;
    if (!h) continue;
    const bn = log.blockNumber ?? 0n;
    const existing = byHash.get(h);
    if (!existing || bn > existing.blockNumber) {
      byHash.set(h, { hash: h as `0x${string}`, blockNumber: bn });
    }
  }

  // extraHashes 직접 조회 — 스캐너 범위 밖이거나 아직 로그 인덱싱 전인 tx.
  // receipt만 잡히면 blockNumber가 나오므로 그 시점에 byHash에 합류시켜서
  // 나머지 파이프라인(txBody / block timestamp / movement 추출)이 평소대로
  // 처리해줌.
  let extraHashesFoundCount = 0;
  if (extraHashes.length > 0) {
    const extraReceipts = await Promise.all(
      extraHashes.map((hash) =>
        client
          .getTransactionReceipt({ hash })
          .then((rc) => ({ hash, rc })) // rc: TransactionReceipt | null narrowed by catch
          .catch(() => ({ hash, rc: null })),
      ),
    );
    for (const { hash, rc } of extraReceipts) {
      if (!rc) continue;
      // 이 tx의 로그 중 하나라도 user와 관련이 있어야 내 활동으로 인정.
      // (ensureAllowance나 writeAndWait에서 owner/account 기준으로 기록하긴
      // 했지만, 방어적으로 검증해서 다른 지갑 hash 들어와도 무시되게 함)
      const touchesUser = (rc.logs ?? []).some((log: any) => {
        const t0 = log.topics?.[0];
        if (t0 !== TRANSFER_TOPIC0 && t0 !== APPROVAL_TOPIC0) return false;
        const addr1 = topicToAddress(log.topics?.[1]);
        const addr2 = topicToAddress(log.topics?.[2]);
        return addr1 === userLc || addr2 === userLc;
      });
      if (!touchesUser) continue;
      const bn = rc.blockNumber as bigint;
      const existing = byHash.get(hash);
      if (!existing || bn > existing.blockNumber) {
        byHash.set(hash, { hash, blockNumber: bn });
      }
      extraHashesFoundCount++;
    }
  }

  // Sort by blockNumber desc → take top N so we only pay for getTransaction
  // / getBlock on what the user will see.
  const sorted = [...byHash.values()].sort((a, b) =>
    b.blockNumber < a.blockNumber ? -1 : b.blockNumber > a.blockNumber ? 1 : 0,
  );
  const top = sorted.slice(0, limit);

  // Parallel fetch: tx body + receipt (for movements + status) + block timestamp.
  const uniqueBlocks = Array.from(new Set(top.map((t) => t.blockNumber.toString())));

  const [txResults, receiptResults, blockResults] = await Promise.all([
    Promise.all(
      top.map((t) =>
        client
          .getTransaction({ hash: t.hash })
          .then((tx) => ({ hash: t.hash, tx }))
          .catch(() => ({ hash: t.hash, tx: null })),
      ),
    ),
    Promise.all(
      top.map((t) =>
        client
          .getTransactionReceipt({ hash: t.hash })
          .then((rc) => ({ hash: t.hash, rc }))
          .catch(() => ({ hash: t.hash, rc: null })),
      ),
    ),
    Promise.all(
      uniqueBlocks.map((bnStr) =>
        client
          .getBlock({ blockNumber: BigInt(bnStr) })
          .then((blk) => ({ bn: bnStr, ts: blk.timestamp }))
          .catch(() => ({ bn: bnStr, ts: 0n })),
      ),
    ),
  ]);

  const txByHash = new Map<string, any>();
  for (const r of txResults) if (r.tx) txByHash.set(r.hash, r.tx);
  const rcByHash = new Map<string, any>();
  for (const r of receiptResults) if (r.rc) rcByHash.set(r.hash, r.rc);
  const tsByBlock = new Map<string, bigint>();
  for (const b of blockResults) tsByBlock.set(b.bn, b.ts);

  // Extract raw movements (token + amount + direction) from receipts first.
  // We defer metadata lookup until we know which tokens are actually needed.
  type RawMove = {
    token: string;
    amount: bigint;
    direction: "in" | "out";
    counterparty: string;
  };
  type RawApproval = {
    token: string;
    spender: string;
    amount: bigint;
  };
  const rawMovesByHash = new Map<string, RawMove[]>();
  const rawApprovalsByHash = new Map<string, RawApproval[]>();
  const tokensNeeded = new Set<string>();

  for (const t of top) {
    const rc = rcByHash.get(t.hash);
    if (!rc?.logs) continue;
    const moves: RawMove[] = [];
    const approvals: RawApproval[] = [];
    for (const log of rc.logs as Array<{
      topics: string[];
      data: string;
      address: string;
    }>) {
      if (!log.topics) continue;
      const topic0 = log.topics[0];

      if (topic0 === TRANSFER_TOPIC0) {
        // ERC20 Transfer has 3 topics (event + from + to). ERC721 has 4
        // (+ tokenId). Skip 721 so we don't report an NFT as "amount 1 wei".
        if (log.topics.length !== 3) continue;
        const from = topicToAddress(log.topics[1]);
        const to = topicToAddress(log.topics[2]);
        if (from !== userLc && to !== userLc) continue;
        let amount: bigint;
        try {
          amount = BigInt(log.data);
        } catch {
          continue;
        }
        const direction: "in" | "out" = to === userLc ? "in" : "out";
        moves.push({
          token: log.address.toLowerCase(),
          amount,
          direction,
          // The "other side" of the transfer — for swaps this is the pool,
          // for V2 mints this is the pair, for V3 mints this is the pool
          // contract (transferred via uniswapV3MintCallback).
          counterparty: direction === "out" ? to : from,
        });
        tokensNeeded.add(log.address.toLowerCase());
        continue;
      }

      if (topic0 === APPROVAL_TOPIC0) {
        // Only ERC20 approvals (3 topics). ERC721's Approval has tokenId as
        // the 3rd indexed topic — semantically different and we don't want
        // to render "NFT 승인" as a token amount.
        if (log.topics.length !== 3) continue;
        const owner = topicToAddress(log.topics[1]);
        if (owner !== userLc) continue;
        const spender = topicToAddress(log.topics[2]);
        let amount: bigint;
        try {
          amount = BigInt(log.data);
        } catch {
          continue;
        }
        approvals.push({
          token: log.address.toLowerCase(),
          spender,
          amount,
        });
        tokensNeeded.add(log.address.toLowerCase());
      }
    }
    if (moves.length > 0) rawMovesByHash.set(t.hash, moves);
    if (approvals.length > 0) rawApprovalsByHash.set(t.hash, approvals);
  }

  // Resolve (and cache) symbol + decimals for every token we reference.
  await resolveTokenMeta(client, [...tokensNeeded]);

  const items: ExplorerTx[] = top.map((t) => {
    const tx = txByHash.get(t.hash);
    const rc = rcByHash.get(t.hash);
    const ts = tsByBlock.get(t.blockNumber.toString()) ?? 0n;
    const raw = rawMovesByHash.get(t.hash) ?? [];
    const movements: TokenMovement[] = raw.map((m) => {
      const meta = TOKEN_META_CACHE.get(m.token) ?? { symbol: "?", decimals: 18 };
      return {
        token: m.token as `0x${string}`,
        symbol: meta.symbol,
        decimals: meta.decimals,
        amount: m.amount.toString(),
        direction: m.direction,
        counterparty: m.counterparty,
      };
    });

    const rawApprovals = rawApprovalsByHash.get(t.hash) ?? [];
    const approvals: TokenApproval[] = rawApprovals.map((a) => {
      const meta = TOKEN_META_CACHE.get(a.token) ?? { symbol: "?", decimals: 18 };
      return {
        token: a.token as `0x${string}`,
        symbol: meta.symbol,
        decimals: meta.decimals,
        spender: a.spender,
        amount: a.amount.toString(),
        isUnlimited: a.amount === MAX_UINT256,
      };
    });

    // receipt.status is "success" | "reverted" on viem. If we didn't get the
    // receipt, assume success (log-scan only surfaces txs that emitted at
    // least one event — a total revert wouldn't appear anyway).
    const isError: "0" | "1" =
      rc && rc.status && rc.status !== "success" ? "1" : "0";

    if (!tx) {
      return {
        hash: t.hash,
        from: "",
        to: null,
        value: "0",
        timeStamp: String(ts),
        blockNumber: t.blockNumber.toString(),
        isError,
        movements,
        approvals,
      };
    }
    const input: string | undefined = tx.input;
    return {
      hash: t.hash,
      from: (tx.from as string) ?? "",
      to: (tx.to as string | null) ?? null,
      value: String(tx.value ?? 0n),
      timeStamp: String(ts),
      blockNumber: t.blockNumber.toString(),
      isError,
      methodId:
        input && input.length >= 10 ? input.slice(0, 10) : undefined,
      input,
      movements,
      approvals,
    };
  });

  return Response.json({
    items,
    source: "rpc-logs",
    ...(debug
      ? {
          debug: {
            fromBlock: fromBlock.toString(),
            toBlock: latest.toString(),
            // tip 진단 — 서버 probes vs 클라이언트 힌트가 얼마나 벌어져 있는지
            // 보면 RPC 어느 쪽이 lag 원인인지 파악 가능. serverLatest 가
            // 힌트보다 수만 블록 낮으면 퍼블릭 RPC 자체가 stale.
            serverLatestProbes: validProbes.map((v) => v.toString()),
            serverLatestMax: serverLatest.toString(),
            clientLatestHint: clientLatestHint.toString(),
            // 힌트가 서버 tip보다 MAX_CLIENT_HINT_LEAD 이상 앞서서 버려진 경우.
            // true면 지갑이 다른 체인에 연결돼있거나 잘못된 값을 줬단 뜻.
            clientHintAccepted: hintAccepted,
            effectiveLatest: latest.toString(),
            chunks: Number(CHUNK_COUNT),
            chunkSize: BLOCK_CHUNK.toString(),
            asFromLogs: asFrom.logs.length,
            asToLogs: asTo.logs.length,
            approvalLogs: approvalsScan.logs.length,
            // 실패한 청크 범위 — 한 번이라도 여기 값이 찍혔다면 해당 구간의
            // tx가 누락됐을 수 있음. 특히 마지막 청크가 실패하면 방금 낸
            // tx가 안 보이는 증상으로 나타남.
            failedRanges: {
              asFrom: asFrom.failures,
              asTo: asTo.failures,
              approvals: approvalsScan.failures,
            },
            uniqueTxs: byHash.size,
            returned: items.length,
            tokensResolved: tokensNeeded.size,
            tokenCacheSize: TOKEN_META_CACHE.size,
            txsWithApprovals: rawApprovalsByHash.size,
            // 클라이언트가 로컬에서 보내준 최근 해시 중 receipt 직접 조회에
            // 성공한 개수. 스캐너 RPC가 뒤쳐진 상황을 진단할 때 결정적 단서.
            extraHashesRequested: extraHashes.length,
            extraHashesFound: extraHashesFoundCount,
          },
        }
      : {}),
  });
}
