"use client";

// ── Client-side recent tx cache ────────────────────────────────────────────
// 내 지갑에서 방금 낸 tx의 해시를 잠깐 기억해뒀다가 /api/activity 호출 시
// 쿼리 파라미터로 함께 넘겨서, 서버 로그 스캐너의 RPC가 체인 tip보다 뒤쳐져
// 있는 상황에서도 해시 직접 조회(getTransactionReceipt)로 바로 찾을 수
// 있게 해준다.
//
// 배경:
//   StableNet 퍼블릭 RPC가 종종 수만 블록 뒤쳐진 상태로 응답해서, getLogs
//   기반의 활동 스캐너가 방금 mine된 tx를 "존재하지 않는 블록"으로 취급하는
//   증상이 있었음 (increaseLiquidity가 활동 내역에 안 뜨는 이슈).
//   hash는 노드간 전파도 빠르고 eth_getTransactionReceipt는 로그 인덱싱과
//   별개 경로라 스캐너 RPC가 뒤쳐져 있어도 다른 노드가 찾아줄 확률이 높음.
//
// 왜 localStorage:
//   - 페이지 새로고침 / 탭 전환에도 살아있어야 함
//   - 지갑별 격리 필요 (여러 주소 쓰는 경우)
//   - 24h TTL로 자동 청소 — DB 흉내내지 않음
//
// 저장 포맷:
//   stablefi_pending_txs → { [lowerAddress]: Array<{hash, ts}> }

const STORAGE_KEY = "stablefi_pending_txs";
const TTL_MS = 24 * 60 * 60 * 1000; // 24h — 서버 스캐너가 그 안엔 캐치업함
const MAX_PER_ADDRESS = 30;         // 너무 많이 쌓이면 쿼리스트링 폭발 방지

export interface PendingTx {
  hash: `0x${string}`;
  /** Epoch ms — 제출 시점(mine 직후). TTL 계산용. */
  ts: number;
}

type Store = Record<string, PendingTx[]>;

function readStore(): Store {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    // 파싱 깨지면 그냥 초기화 — 이 데이터는 복구할 가치가 없음
    return {};
  }
}

function writeStore(store: Store): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage quota 같은 상황은 드물지만 조용히 무시
  }
}

/** Drop TTL-expired entries in-place for one address. Returns the pruned list. */
function pruneForAddress(list: PendingTx[]): PendingTx[] {
  const cutoff = Date.now() - TTL_MS;
  return list
    .filter((t) => t.ts >= cutoff)
    // 최신 순 정렬(혹시 모를 삽입 순서 뒤섞임 방지)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_PER_ADDRESS);
}

/** Record a just-confirmed tx hash for the given address. */
export function recordPendingTx(address: string, hash: `0x${string}`): void {
  if (!address || !hash) return;
  const key = address.toLowerCase();
  const store = readStore();
  const list = pruneForAddress(store[key] ?? []);
  // 중복이면 ts만 갱신
  const existing = list.find((t) => t.hash.toLowerCase() === hash.toLowerCase());
  if (existing) {
    existing.ts = Date.now();
  } else {
    list.unshift({ hash, ts: Date.now() });
  }
  store[key] = list.slice(0, MAX_PER_ADDRESS);
  writeStore(store);
}

/** Read the (pruned) pending-tx list for an address. */
export function getPendingTxs(address: string): PendingTx[] {
  if (!address) return [];
  const key = address.toLowerCase();
  const store = readStore();
  const pruned = pruneForAddress(store[key] ?? []);
  // 프룬 결과가 원본과 다르면 저장도 같이 갱신해서 다음 호출부터 가벼워지게
  if ((store[key]?.length ?? 0) !== pruned.length) {
    store[key] = pruned;
    writeStore(store);
  }
  return pruned;
}

/**
 * 지갑 provider(window.ethereum)에서 직접 block number를 읽어온다. 서버 /api/rpc
 * 와 같은 URL을 쓰더라도 지갑은 보통 자기 개별 커넥션을 유지하고 있어서
 * load-balancer 상에서 별개 노드에 라우팅될 수 있다. 여기서 읽은 값이 서버
 * probes보다 높으면 활동 API에 힌트로 넘겨서 stale RPC를 우회한다.
 *
 * ⚠ 반드시 timeout으로 레이스해야 한다. MetaMask circuit breaker cooldown,
 *    지갑 잠금, 체인 스위칭 중, RPC 포워드 블록 등 상태에선 `eth_request`가
 *    resolve도 reject도 안 하고 영원히 pending으로 남는 케이스가 있음. 그러면
 *    이 함수를 await하는 React Query queryFn이 멈춰서 거래내역 탭이 permanent
 *    loading 상태가 됨 (UI상으로는 "아예 안 뜨네" 증상).
 *
 * 실패/타임아웃이면 0n — 힌트가 없다는 뜻이고 서버는 자체 probe max로 fallback.
 */
const WALLET_BLOCK_TIMEOUT_MS = 1500;

export async function readWalletBlockNumber(): Promise<bigint> {
  if (typeof window === "undefined") return 0n;
  const eth = (window as any).ethereum;
  if (!eth?.request) return 0n;
  try {
    const request = eth.request({ method: "eth_blockNumber" }) as Promise<unknown>;
    // 타임아웃과 레이스. resolve 안 되면 0n 반환 — 힌트 없이 서버 probe만 믿음.
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), WALLET_BLOCK_TIMEOUT_MS),
    );
    const result = await Promise.race([request, timeout]);
    if (result === null) return 0n;
    const hex = result;
    if (typeof hex !== "string" || !hex.startsWith("0x")) return 0n;
    return BigInt(hex);
  } catch {
    return 0n;
  }
}

/** Remove hashes that have been confirmed server-side (already in activity). */
export function prunePendingTxs(address: string, confirmedHashes: string[]): void {
  if (!address || confirmedHashes.length === 0) return;
  const key = address.toLowerCase();
  const store = readStore();
  const list = store[key];
  if (!list || list.length === 0) return;
  const confirmedSet = new Set(confirmedHashes.map((h) => h.toLowerCase()));
  const next = list.filter((t) => !confirmedSet.has(t.hash.toLowerCase()));
  if (next.length === list.length) return; // 바뀐 게 없으면 write 스킵
  store[key] = next;
  writeStore(store);
}
