"use client";

import type { Abi, Hex } from "viem";
import { parseUnits } from "viem";
import { publicClient } from "./client";
import { getWalletClient } from "./walletClient";
import { getEthereumProvider, getProviderByRdns } from "./ethereum";
import { STABLENET_TESTNET } from "./chain";
import { recordPendingTx } from "./pendingTxs";
import ERC20Json from "./abi/ERC20.json";

const ERC20 = ERC20Json as Abi;

const STORAGE_RDNS = "stablefi_wallet_rdns";

/**
 * Return the EIP-1193 provider the user actually connected with (same
 * resolution rules as `getWalletClient`). Mirrors walletClient's logic so
 * pre-flight checks talk to the same wallet the tx will ultimately use.
 */
function resolveActiveProvider(): any | null {
  if (typeof window === "undefined") return null;
  const savedRdns = localStorage.getItem(STORAGE_RDNS);
  if (savedRdns) {
    const detail = getProviderByRdns(savedRdns);
    if (detail) return detail.provider;
  }
  return getEthereumProvider();
}

/**
 * Ensure the user's wallet is on StableNet Testnet before we send a tx.
 * viem's writeContract throws "current chain of the wallet (id: X) does not
 * match the target chain (id: 8283)" if the wallet is on something else,
 * which is confusing for users — better to pro-actively switch.
 *
 * Best-effort: if switch + add both fail, we throw a recognizable error so
 * friendlyTxError surfaces a helpful Korean message.
 */
async function ensureCorrectChain(): Promise<void> {
  const provider = resolveActiveProvider();
  if (!provider) return;
  let hex: string;
  try {
    hex = await provider.request({ method: "eth_chainId" });
  } catch {
    return; // can't read — let the tx attempt surface the real error
  }
  const current = parseInt(hex, 16);
  if (current === STABLENET_TESTNET.id) return;

  const targetHex = "0x" + STABLENET_TESTNET.id.toString(16);
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: targetHex }],
    });
    return;
  } catch (switchErr: any) {
    if (switchErr?.code === 4001) {
      throw switchErr; // user rejected — don't silently retry with add
    }
    // Fall through to add (Rabby and others don't always return 4902).
  }
  try {
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: targetHex,
          chainName: STABLENET_TESTNET.name,
          rpcUrls: [STABLENET_TESTNET.rpcUrl],
          nativeCurrency: STABLENET_TESTNET.nativeCurrency,
          blockExplorerUrls: [STABLENET_TESTNET.explorer],
        },
      ],
    });
  } catch {
    /* best-effort — let the tx attempt throw the real mismatch error */
  }
}

/**
 * Pre-compute the gas LIMIT via our /api/rpc proxy and hand it to the
 * wallet as a hint. Without this, Rabby/MetaMask fire `eth_estimateGas`
 * directly at the public StableNet endpoint. Pre-fetching here lets the
 * first `eth_sendTransaction` skip that extra call and ride our proxy's
 * retry layer.
 *
 * Why we DON'T pre-fetch fee fields (maxFeePerGas / maxPriorityFeePerGas):
 *
 * StableNet sets the priority tip via validator governance (`GovValidator`
 * contract). The node silently clamps any user-supplied tip to the
 * governance value — we confirmed this on two live txs (block 6989011,
 * 7082158): both paid effective priority = 27,600 Gwei regardless of what
 * the wallet sent. So our hint adds no value.
 *
 * But it can actively HURT: if we pass a hint that differs from the
 * wallet's internal default (MetaMask in particular has opinionated
 * baseline priority values), the wallet simulation layer gets confused
 * and sometimes pre-rejects the approve popup without ever showing it.
 * Symptom: user reports "approve rejected" even though they never saw
 * the signing prompt. Dropping fee hints lets the wallet do its own
 * fresh estimation — safer, especially right after the user
 * deleted+re-added the chain (wallet fee cache is fresh).
 *
 * Refs:
 *   https://docs.stablenet.network/en/transaction-processing/6.4-gas-fee-policy
 *
 * Best-effort: if gas estimation fails, we return {} and let the wallet
 * estimate everything itself. A 20% gas buffer covers variance between
 * our estimate and the wallet's accounting (e.g. different block state).
 */
async function prefetchGasHints(params: {
  account: `0x${string}`;
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
}): Promise<{ gas?: bigint }> {
  try {
    const estimated = await publicClient.estimateContractGas({
      account: params.account,
      address: params.address,
      abi: params.abi,
      functionName: params.functionName,
      args: params.args,
      value: params.value,
    });
    return { gas: (estimated * 120n) / 100n }; // +20% headroom
  } catch {
    return {};
  }
}

// Default approval size — always 1,000 tokens so the popup shows a clean,
// predictable number rather than an unlimited (uint256 max) amount. Users
// found the unlimited approval scary and non-obvious; 1,000 is a round
// number that covers typical deposit/swap sizes in a single signature.
// If a specific tx requires more, we bump to that exact amount instead
// (see max(amount, 1000) below) to avoid an immediate re-approval.
const DEFAULT_APPROVE_TOKENS = "1000";

/**
 * Ensure `spender` has at least `amount` allowance for `token` from `owner`.
 * If not, prompts the user to sign an approval for ~1,000 tokens (or the
 * exact tx amount, whichever is larger) so typical follow-ups don't require
 * another popup but the allowance stays visible.
 *
 * Returns true when a new approval was sent (and confirmed), false when
 * existing allowance was already sufficient.
 */
export async function ensureAllowance({
  token,
  owner,
  spender,
  amount,
  decimals,
  onStatus,
}: {
  token: `0x${string}`;
  owner: `0x${string}`;
  spender: `0x${string}`;
  amount: bigint;
  /** Token decimals — needed to compute the 1,000-token default. */
  decimals: number;
  onStatus?: (s: TxStatus) => void;
}): Promise<boolean> {
  const current = (await publicClient.readContract({
    address: token,
    abi: ERC20,
    functionName: "allowance",
    args: [owner, spender],
  })) as bigint;

  if (current >= amount) return false;

  // 1,000 tokens in raw units. Use the larger of (1000, amount) so the
  // current tx is guaranteed to succeed even if it needs more than 1,000.
  const thousand = parseUnits(DEFAULT_APPROVE_TOKENS, decimals);
  const approveAmount = amount > thousand ? amount : thousand;

  onStatus?.({ kind: "awaitingSignature", label: "토큰 사용 승인 중" });

  await ensureCorrectChain();
  const wallet = getWalletClient();
  const hints = await prefetchGasHints({
    account: owner,
    address: token,
    abi: ERC20,
    functionName: "approve",
    args: [spender, approveAmount],
  });
  const hash = await wallet.writeContract({
    account: owner,
    chain: publicClient.chain,
    address: token,
    abi: ERC20,
    functionName: "approve",
    args: [spender, approveAmount],
    ...hints,
  });

  onStatus?.({ kind: "pending", label: "승인 처리 중", hash });
  await publicClient.waitForTransactionReceipt({ hash });
  // 방금 mine된 tx 해시를 로컬에 기록 → 이후 /api/activity 호출이 이걸
  // extraHashes로 같이 태워보내서, 스캐너 RPC가 뒤쳐져 있어도 receipt
  // 직접 조회로 활동 내역에 즉시 뜨게 됨.
  recordPendingTx(owner, hash);
  return true;
}

/**
 * Send an arbitrary write + wait for receipt. Wraps common error shapes
 * into a friendlier Korean message.
 */
export async function writeAndWait({
  account,
  address,
  abi,
  functionName,
  args,
  value,
  onStatus,
}: {
  account: `0x${string}`;
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
  onStatus?: (s: TxStatus) => void;
}): Promise<Hex> {
  onStatus?.({ kind: "awaitingSignature", label: "지갑에서 서명해주세요" });

  await ensureCorrectChain();
  const wallet = getWalletClient();
  const hints = await prefetchGasHints({
    account,
    address,
    abi,
    functionName,
    args,
    value,
  });
  const hash = await wallet.writeContract({
    account,
    chain: publicClient.chain,
    address,
    abi,
    functionName,
    args,
    value,
    ...hints,
  });

  onStatus?.({ kind: "pending", label: "처리 중", hash });
  await publicClient.waitForTransactionReceipt({ hash });
  // 로컬 캐시에 해시 기록 — ensureAllowance와 동일 이유(스캐너 RPC lag 대응).
  recordPendingTx(account, hash);
  return hash;
}

// ── Status channel ───────────────────────────────────────────────────────────
export type TxStatus =
  | { kind: "awaitingSignature"; label: string }
  | { kind: "pending"; label: string; hash: Hex };

/**
 * Turn wallet / RPC errors into short Korean messages a user can act on.
 * Fallback keeps the raw shortMessage so we never swallow a useful signal.
 *
 * NOTE: viem wraps raw RPC errors — the original message often lives nested
 * inside `cause.message` / `cause.data.message` / `details`, while the top
 * `shortMessage` gets a generic label like "Resource unavailable". So we
 * concatenate every string field we can reach and match patterns against
 * that combined haystack. Otherwise rate-limit errors (which carry
 * "RPC endpoint returned too many errors..." in a nested field) get
 * misclassified as generic -32002 busy-wallet.
 */
export function friendlyTxError(e: any): string {
  const short: string =
    e?.shortMessage ?? e?.cause?.shortMessage ?? e?.message ?? String(e);
  const code = e?.code ?? e?.cause?.code ?? e?.cause?.cause?.code;

  // Gather every string we might find buried in viem's error chain.
  const parts: string[] = [
    short,
    e?.message,
    e?.details,
    e?.cause?.message,
    e?.cause?.details,
    e?.cause?.shortMessage,
    e?.cause?.data?.message,
    e?.cause?.cause?.message,
    e?.cause?.cause?.details,
    e?.cause?.cause?.shortMessage,
    typeof e?.stack === "string" ? e.stack : undefined,
  ].filter((s): s is string => typeof s === "string" && s.length > 0);
  const hay = parts.join(" | ");

  if (/User rejected|User denied|rejected the request/i.test(hay)) {
    return "사용자가 서명을 취소했어요";
  }
  if (/insufficient funds/i.test(hay)) {
    return "가스비가 부족해요";
  }
  if (/nonce too low|replacement/i.test(hay)) {
    return "지갑의 대기 중인 트랜잭션을 먼저 처리해주세요";
  }
  // MetaMask's circuit breaker. When its internal RPC sees ≥3 consecutive
  // upstream failures it enters a cooldown and rejects EVERY request for
  // ~30s with "RPC endpoint returned too many errors, retrying in N minutes".
  // During cooldown nothing we do (retry, prefetch, etc.) helps — the wallet
  // itself is the bottleneck. Rabby doesn't have this specific breaker.
  //
  // Must run before the generic -32002 branch because the breaker carries
  // -32002. We pull the "retrying in N minutes" figure out of the message
  // so the user knows the exact wait instead of guessing.
  if (
    /too many errors/i.test(hay) ||
    (/RPC endpoint/i.test(hay) && /retrying/i.test(hay)) ||
    /rate[- ]?limit/i.test(hay) ||
    /429/.test(hay)
  ) {
    console.error("[friendlyTxError] rate-limit classification", {
      shortMessage: short,
      code,
      parts,
      raw: e,
    });
    const minutesMatch = /retrying in\s*([\d.]+)\s*minutes?/i.exec(hay);
    const isMetaMask = /MetaMask/i.test(hay) || /inpage\.js/i.test(hay);
    if (isMetaMask) {
      const wait = minutesMatch
        ? `약 ${Math.round(parseFloat(minutesMatch[1]) * 60)}초`
        : "30초";
      return `MetaMask가 RPC 과부하로 ${wait} 대기 중이에요. 잠시 후 다시 시도하거나 Rabby 같은 다른 지갑으로 연결해보세요`;
    }
    return "StableNet RPC가 잠시 바빠요. 몇 초 후 다시 시도해주세요";
  }
  // Network-level fetch failure — the wallet (or our publicClient) couldn't
  // reach the RPC at all. viem wraps this as a contract revert with reason
  // "Failed to fetch" / "fetch failed" / "NetworkError", which is misleading;
  // nothing reverted, the request never reached a node.
  if (
    /Failed to fetch/i.test(hay) ||
    /fetch failed/i.test(hay) ||
    /NetworkError/i.test(hay) ||
    /ERR_NETWORK/i.test(hay) ||
    /ERR_INTERNET_DISCONNECTED/i.test(hay) ||
    /ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(hay)
  ) {
    return "StableNet RPC에 연결할 수 없어요. 지갑의 RPC 엔드포인트를 확인하거나 잠시 후 다시 시도해주세요";
  }
  // Wallet busy / popup already open / overlapping request.
  // NOT a session-loss — user should just retry.
  // We only trigger this when the text clearly indicates "already processing";
  // bare -32002 without that text is usually something else (rate-limit above).
  if (
    /Already processing/i.test(hay) ||
    /Requested resource not available/i.test(hay) ||
    (code === -32002 && /popup|pending request/i.test(hay))
  ) {
    return "지갑이 다른 요청을 처리 중이에요. 지갑을 열어서 확인하거나 잠시 후 다시 시도해주세요";
  }
  // True permission loss / revoked session.
  if (isStaleWalletError(e)) {
    return "지갑 권한이 해제됐어요. 다시 연결해주세요";
  }
  if (
    /chain mismatch|wrong chain|switch chain/i.test(hay) ||
    /does not match the target chain/i.test(hay) ||
    /current chain of the wallet/i.test(hay)
  ) {
    return "지갑이 StableNet Testnet이 아닌 다른 네트워크에 있어요. 상단 배너의 '전환하기'를 눌러주세요";
  }
  if (/no wallet|MetaMask/i.test(hay) && /not found|undefined/i.test(hay)) {
    return "지갑을 찾을 수 없어요. MetaMask를 설치하고 연결해주세요";
  }
  return short;
}

/**
 * Narrow heuristic: was the session *actually* revoked, vs. merely busy?
 *
 * We previously matched on -32002 / "Requested resource not available" too,
 * but those also fire when MetaMask just has another popup open — triggering
 * a disconnect in that case kicked users out mid-flow. So this is now the
 * strict "permission is gone" signal only: -32001 or Unauthorized text.
 *
 * Callers should additionally verify with eth_accounts before disconnecting
 * if they want to be extra safe (see verifyConnection below).
 */
export function isStaleWalletError(e: any): boolean {
  const msg: string =
    e?.shortMessage ?? e?.cause?.shortMessage ?? e?.message ?? String(e);
  const code = e?.code ?? e?.cause?.code;
  return code === -32001 || /Unauthorized|not authorized/i.test(msg);
}

/**
 * Ask the wallet directly whether our session is still valid.
 * Returns true only when eth_accounts returns a non-empty list — meaning
 * the extension still trusts us. Use this before auto-disconnecting on
 * ambiguous errors.
 */
export async function verifyConnection(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const provider = getEthereumProvider();
  if (!provider) return false;
  try {
    const accounts: string[] = await provider.request({
      method: "eth_accounts",
    });
    return accounts && accounts.length > 0;
  } catch {
    return false;
  }
}
