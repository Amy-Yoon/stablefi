"use client";

import { formatUnits } from "viem";
import {
  ArrowDownLeft, ArrowUpRight, ArrowLeftRight, XCircle,
  PiggyBank, Sparkles, Wallet, FileCode2,
} from "lucide-react";
import { STABLENET_TESTNET, CONTRACTS, KNOWN_POOLS } from "@/lib/chain";
import { cn, shortenAddress } from "@/lib/utils";

// ── Shared activity list primitives ─────────────────────────────────────────
// Used by both /app/activity and the home page's "최근 거래내역" widget so
// classification + rendering stay in lockstep. If we add a new method label
// or icon it appears in both places automatically.

export type TokenMovement = {
  token: string;
  symbol: string;
  decimals: number;
  amount: string;           // wei string
  direction: "in" | "out";  // from user's perspective
  /** The address on the other side of this Transfer — pool / pair / recipient.
   *  Used to detect which pool a swap/mint/burn touched. Optional because
   *  older /api/activity responses might not include it. */
  counterparty?: string;
};

/** ERC20 Approval events where the user is owner. Approvals don't emit
 *  Transfer, so without this the UI can't tell which token a 승인 row is for. */
export type TokenApproval = {
  token: string;
  symbol: string;
  decimals: number;
  amount: string;      // wei string
  spender: string;     // lowercase hex — match against contract labels / pool registry
  isUnlimited: boolean;
};

export type ExplorerTx = {
  hash: string;
  from: string;
  to: string | null;
  value: string;       // wei string
  timeStamp: string;   // unix seconds string
  blockNumber: string;
  isError: "0" | "1";
  methodId?: string;
  input?: string;
  gasUsed?: string;
  fee?: string;
  /** ERC20 Transfer events where the user was from or to. Set by /api/activity. */
  movements?: TokenMovement[];
  /** ERC20 Approval events where the user was owner. Set by /api/activity. */
  approvals?: TokenApproval[];
};

export type TxKind =
  | "send"
  | "receive"
  | "swap"
  | "approve"
  | "deposit"
  | "withdraw"
  | "transfer"
  | "contract"
  | "unknown";

// First 10 chars of calldata = function selector. Keep expanding this as we
// observe new method ids in the explorer — unknown ones fall through to the
// generic "contract call" label.
const METHOD_LABELS: Record<string, { label: string; kind: TxKind }> = {
  // ERC20
  "0xa9059cbb": { label: "보내기",       kind: "transfer" }, // transfer
  "0x23b872dd": { label: "보내기",       kind: "transfer" }, // transferFrom
  "0x095ea7b3": { label: "승인",         kind: "approve" },  // approve

  // V3 Router
  "0x414bf389": { label: "바꾸기",       kind: "swap" },     // exactInputSingle
  "0xc04b8d59": { label: "바꾸기",       kind: "swap" },     // exactInput
  // NOTE: 0xac9650d8 (multicall) 은 여기서 다루지 않는다. V3 Router뿐 아니라
  // PositionManager (decreaseLiquidity+collect, mint+refund 등)도 multicall
  // 래퍼를 쓰기 때문에 껍데기만 보고는 종류를 알 수 없다. classify() 안에서
  // 첫 번째 내부 selector를 꺼내 재분류한다.

  // V2 Router
  "0x38ed1739": { label: "바꾸기",       kind: "swap" },
  "0x8803dbee": { label: "바꾸기",       kind: "swap" },
  "0x7ff36ab5": { label: "바꾸기",       kind: "swap" },
  "0x18cbafe5": { label: "바꾸기",       kind: "swap" },
  "0xfb3bdb41": { label: "바꾸기",       kind: "swap" },
  "0x4a25d94a": { label: "바꾸기",       kind: "swap" },

  // V2 Router LP
  "0xe8e33700": { label: "모으기",       kind: "deposit" },
  "0xf305d719": { label: "모으기",       kind: "deposit" },
  "0xbaa2abde": { label: "꺼내기",       kind: "withdraw" },
  "0x02751cec": { label: "꺼내기",       kind: "withdraw" },

  // V3 PositionManager
  "0x88316456": { label: "모으기",       kind: "deposit" },
  "0x219f5d17": { label: "모으기",       kind: "deposit" },
  "0x0c49ccbe": { label: "꺼내기",       kind: "withdraw" },
  "0xfc6f7865": { label: "수수료 수령",   kind: "withdraw" },

  // W-native
  "0xd0e30db0": { label: "WKRC 예치",     kind: "deposit" },
  "0x2e1a7d4d": { label: "WKRC 해제",     kind: "withdraw" },
};

export function knownTargetLabel(to: string | null | undefined): string | null {
  if (!to) return null;
  const lc = to.toLowerCase();
  if (lc === CONTRACTS.v3Router.toLowerCase())          return "V3 Router";
  if (lc === CONTRACTS.v2Router.toLowerCase())          return "V2 Router";
  if (lc === CONTRACTS.v3PositionManager.toLowerCase()) return "V3 Position";
  if (lc === CONTRACTS.v3Factory.toLowerCase())         return "V3 Factory";
  if (lc === CONTRACTS.v2Factory.toLowerCase())         return "V2 Factory";
  const pool = KNOWN_POOLS.find((p) => p.address.toLowerCase() === lc);
  if (pool) return `${pool.label ?? "Pool"} (${pool.version.toUpperCase()})`;
  return null;
}

/**
 * Walk through movements and see if any counterparty matches a pool in our
 * registry — that's the pool this tx hit. Works for:
 *   • swaps    — user's Transfer counterparty = pool/pair directly
 *   • V3 mint  — user → pool (via uniswapV3MintCallback's transferFrom)
 *   • V2 mint  — user → pair
 *   • V3 burn  — pool → user (collect recipient is user)
 *   • V2 burn  — pair → user (after removeLiquidity)
 */
export function detectPoolFromMovements(
  movements: TokenMovement[] | undefined,
): { label: string; version: "v2" | "v3" } | null {
  if (!movements || movements.length === 0) return null;
  for (const m of movements) {
    if (!m.counterparty) continue;
    const lc = m.counterparty.toLowerCase();
    const pool = KNOWN_POOLS.find((p) => p.address.toLowerCase() === lc);
    if (pool) return { label: pool.label ?? "Pool", version: pool.version };
  }
  return null;
}

/**
 * multicall(bytes[] data) 의 input calldata에서 첫 번째 내부 함수 selector를
 * 뽑아낸다. V3 Router 와 V3 PositionManager 는 모두 multicall 래퍼 아래에서
 * 실제 동작(swap / mint / decreaseLiquidity+collect / ...)을 수행하므로,
 * 껍데기 selector(0xac9650d8) 만 보면 종류를 구분할 수 없다.
 *
 * ABI encoding of multicall(bytes[] data):
 *   slot 0                : offset to bytes[] (보통 0x20)
 *   @bytesOffset          : array length
 *   @bytesOffset+32       : head section — offset of element[0], measured
 *                           from head section start (NOT from length slot)
 *   @bytesOffset+64       : offset of element[1]
 *   @bytesOffset+32+elem0 : length of element[0]
 *   다음 4바이트          : 내부 함수 selector ← 이걸 꺼낸다
 *
 * ⚠ 과거에 offset을 length slot 기준으로 계산하다가 V3 decreaseLiquidity
 *   multicall이 "풀 작업" 으로 fallback 되는 버그가 있었음. Solidity ABI
 *   spec상 bytes[] 안의 오프셋은 head 섹션 시작(=length slot 다음)부터 측정.
 */
function extractMulticallInnerSelector(input: string | undefined): string | null {
  if (!input) return null;
  const lc = input.toLowerCase();
  if (!lc.startsWith("0xac9650d8")) return null;
  const body = lc.slice(10); // "0x" + 8-char selector 이후

  // slot 0 — offset to bytes[]
  if (body.length < 64) return null;
  const bytesOffset = parseInt(body.slice(0, 64), 16);
  if (!Number.isFinite(bytesOffset)) return null;

  // array length @ bytesOffset
  const lenStart = bytesOffset * 2;
  if (body.length < lenStart + 64) return null;
  const arrayLen = parseInt(body.slice(lenStart, lenStart + 64), 16);
  if (!Number.isFinite(arrayLen) || arrayLen === 0) return null;

  // head section — 각 element의 오프셋들이 여기서부터 나열됨.
  const headStart = lenStart + 64;
  if (body.length < headStart + 64) return null;
  const elem0Offset = parseInt(body.slice(headStart, headStart + 64), 16);
  if (!Number.isFinite(elem0Offset)) return null;

  // element[0] 위치: head 섹션 시작 + offset (bytes → chars 로 *2).
  // element 는 length(32B) + data(padded). 첫 4바이트 data 가 내부 selector.
  const elem0LenStart = headStart + elem0Offset * 2;
  const elem0DataStart = elem0LenStart + 64;
  if (body.length < elem0DataStart + 8) return null;

  return "0x" + body.slice(elem0DataStart, elem0DataStart + 8);
}

export function classify(tx: ExplorerTx, myAddress: string): {
  kind: TxKind;
  label: string;
} {
  const me = myAddress.toLowerCase();
  const toLc = (tx.to ?? "").toLowerCase();
  const fromLc = (tx.from ?? "").toLowerCase();

  if (toLc === me && fromLc !== me) {
    return { kind: "receive", label: "받기" };
  }

  // multicall: 껍데기가 아니라 첫 내부 호출로 판단한다.
  // decreaseLiquidity + collect → 꺼내기, mint + refundETH → 모으기,
  // exactInputSingle + refundETH → 바꾸기 처럼 정확히 분류됨.
  if (tx.methodId?.toLowerCase() === "0xac9650d8") {
    const inner = extractMulticallInnerSelector(tx.input);
    if (inner && METHOD_LABELS[inner]) {
      return METHOD_LABELS[inner];
    }
    // 내부 selector를 못 뽑거나 매핑이 없으면 to 주소 힌트로 fallback.
    //   PositionManager → 모으기/꺼내기 패턴이 많으므로 "풀 작업"
    //   V3 Router      → 스왑
    if (toLc === CONTRACTS.v3PositionManager.toLowerCase()) {
      return { kind: "contract", label: "풀 작업" };
    }
    if (toLc === CONTRACTS.v3Router.toLowerCase()) {
      return { kind: "swap", label: "바꾸기" };
    }
    // 마지막 fallback: 그냥 컨트랙트 호출
    return { kind: "contract", label: "컨트랙트 호출" };
  }

  if (tx.methodId && METHOD_LABELS[tx.methodId]) {
    const m = METHOD_LABELS[tx.methodId];
    return { kind: m.kind, label: m.label };
  }

  if (
    fromLc === me &&
    (!tx.input || tx.input === "0x") &&
    BigInt(tx.value || "0") > 0n
  ) {
    return { kind: "send", label: "보내기" };
  }

  if (tx.input && tx.input !== "0x") {
    return { kind: "contract", label: "컨트랙트 호출" };
  }

  return { kind: "unknown", label: "거래" };
}

export function formatNative(wei: string): string {
  try {
    const v = Number(formatUnits(BigInt(wei), STABLENET_TESTNET.nativeCurrency.decimals));
    if (v === 0)       return "0";
    if (v < 0.0001)    return "<0.0001";
    if (v < 1)         return v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
    return v.toLocaleString("ko-KR", { maximumFractionDigits: 4 });
  } catch {
    return wei;
  }
}

// Generic token-amount formatter (mirrors formatNative but with arbitrary decimals).
export function formatAmount(wei: string, decimals: number): string {
  try {
    const v = Number(formatUnits(BigInt(wei), decimals));
    if (v === 0)       return "0";
    if (v < 0.0001)    return "<0.0001";
    if (v < 1)         return v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
    return v.toLocaleString("ko-KR", { maximumFractionDigits: 4 });
  } catch {
    return wei;
  }
}

/**
 * Build a short subtitle describing token flow for swap / deposit / withdraw
 * rows (e.g. "TokenA → TokenB", "TokenA + TokenB"). Falls back to null when
 * movements don't exist or the shape doesn't match a known pattern — caller
 * then uses the default counterparty subtitle.
 */
export function describeMovements(
  kind: TxKind,
  movements: TokenMovement[] | undefined,
): string | null {
  if (!movements || movements.length === 0) return null;
  const outs = movements.filter((m) => m.direction === "out");
  const ins  = movements.filter((m) => m.direction === "in");

  if (kind === "swap") {
    const sym = (arr: TokenMovement[]) =>
      Array.from(new Set(arr.map((m) => m.symbol))).join("·");
    if (outs.length >= 1 && ins.length >= 1) {
      return `${sym(outs)} → ${sym(ins)}`;
    }
    return null;
  }

  if (kind === "deposit") {
    if (outs.length >= 1) {
      return Array.from(new Set(outs.map((m) => m.symbol))).join(" + ");
    }
    return null;
  }

  if (kind === "withdraw") {
    if (ins.length >= 1) {
      return Array.from(new Set(ins.map((m) => m.symbol))).join(" + ");
    }
    return null;
  }

  return null;
}

/**
 * Collapse movements to at most 2 user-facing lines:
 *   swap     → first out, first in
 *   deposit  → outs only (merged per symbol)
 *   withdraw → ins only (merged per symbol)
 *   send     → first out
 *   receive  → first in
 *
 * Movements of the same token on the same side are summed so a V3 position
 * collect that emits two "in" transfers for the same token appears as one
 * line instead of doubling up.
 */
export function pickDisplayMovements(
  kind: TxKind,
  movements: TokenMovement[] | undefined,
): TokenMovement[] {
  if (!movements || movements.length === 0) return [];
  const group = (arr: TokenMovement[]): TokenMovement[] => {
    const acc = new Map<string, TokenMovement>();
    for (const m of arr) {
      const key = `${m.token.toLowerCase()}:${m.direction}`;
      const cur = acc.get(key);
      if (!cur) {
        acc.set(key, { ...m });
      } else {
        cur.amount = (BigInt(cur.amount) + BigInt(m.amount)).toString();
      }
    }
    return [...acc.values()];
  };

  const outs = group(movements.filter((m) => m.direction === "out"));
  const ins  = group(movements.filter((m) => m.direction === "in"));

  if (kind === "swap")    return [outs[0], ins[0]].filter(Boolean) as TokenMovement[];
  if (kind === "send")    return outs.slice(0, 1);
  if (kind === "receive") return ins.slice(0, 1);
  if (kind === "deposit") return outs.slice(0, 2);
  if (kind === "withdraw") return ins.slice(0, 2);
  // transfer / contract / approve / unknown — surface whatever we have
  return [...outs, ...ins].slice(0, 2);
}

export function formatWhen(unixSec: string): string {
  const n = Number(unixSec);
  if (!n) return "";
  const diff = Math.floor(Date.now() / 1000) - n;
  if (diff < 60)          return "방금 전";
  if (diff < 3600)        return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400)       return `${Math.floor(diff / 3600)}시간 전`;
  if (diff < 86400 * 7)   return `${Math.floor(diff / 86400)}일 전`;
  const d = new Date(n * 1000);
  return d.toLocaleDateString("ko-KR", { year: "2-digit", month: "2-digit", day: "2-digit" });
}

export function KindIcon({ kind, error }: { kind: TxKind; error: boolean }) {
  const base = "w-10 h-10 shrink-0 rounded-full flex items-center justify-center";
  if (error) {
    return (
      <span className={cn(base, "bg-gain-50 text-gain-500")}>
        <XCircle size={18} strokeWidth={2.2} />
      </span>
    );
  }
  switch (kind) {
    case "receive":
      return (
        <span className={cn(base, "bg-emerald-50 text-emerald-500")}>
          <ArrowDownLeft size={18} strokeWidth={2.3} />
        </span>
      );
    case "send":
    case "transfer":
      return (
        <span className={cn(base, "bg-neutral-50 text-neutral-500")}>
          <ArrowUpRight size={18} strokeWidth={2.3} />
        </span>
      );
    case "swap":
      return (
        <span className={cn(base, "bg-toss-50 text-toss-500")}>
          <ArrowLeftRight size={18} strokeWidth={2.3} />
        </span>
      );
    case "deposit":
      return (
        <span className={cn(base, "bg-violet-50 text-violet-500")}>
          <PiggyBank size={18} strokeWidth={2.3} />
        </span>
      );
    case "withdraw":
      return (
        <span className={cn(base, "bg-amber-50 text-amber-600")}>
          <Wallet size={18} strokeWidth={2.3} />
        </span>
      );
    case "approve":
      return (
        <span className={cn(base, "bg-neutral-50 text-neutral-500")}>
          <Sparkles size={18} strokeWidth={2.3} />
        </span>
      );
    default:
      return (
        <span className={cn(base, "bg-neutral-50 text-neutral-500")}>
          <FileCode2 size={18} strokeWidth={2.3} />
        </span>
      );
  }
}

export interface ActivityRowProps {
  tx: ExplorerTx;
  myAddress: string;
  /** Compact density used on home widget — hides secondary metadata. */
  compact?: boolean;
  /** Hide the target-contract badge (useful in dense home widget). */
  hideTargetBadge?: boolean;
}

export function ActivityRow({ tx, myAddress, compact, hideTargetBadge }: ActivityRowProps) {
  const { kind, label } = classify(tx, myAddress);
  const error = tx.isError === "1";
  const native = BigInt(tx.value || "0");
  const hasNative = native > 0n;

  // Movements from receipts take priority over bare native value. For a
  // simple native send (no ERC20 wrapper), movements will be empty and we
  // fall back to the native value.
  const displayMoves = pickDisplayMovements(kind, tx.movements);

  // Approval events (no Transfer → empty movements). Pick the first one; if
  // a tx approves multiple tokens (rare via multicall), we'd need a multi-line
  // treatment but the common case is single approval.
  const primaryApproval =
    kind === "approve" && tx.approvals && tx.approvals.length > 0
      ? tx.approvals[0]
      : null;

  // Pool badge: try to identify which pool this tx hit via movement
  // counterparties. Replaces the contract-label fallback when available
  // because "TKA-WKRC V3" is strictly more informative than "V3 Router".
  const pool = detectPoolFromMovements(tx.movements);
  const poolBadge = pool ? `${pool.label} ${pool.version.toUpperCase()}` : null;

  // For approve: tx.to is the TOKEN contract, so knownTargetLabel would try
  // to label it (and fail) — what we really want is the SPENDER's label,
  // which tells the user "승인 to V3 Router" vs "승인 to V2 Router". This
  // is far more actionable than the token address.
  const approveSpenderLabel = primaryApproval
    ? knownTargetLabel(primaryApproval.spender) ?? shortenAddress(primaryApproval.spender)
    : null;

  const fallbackTargetLabel =
    !poolBadge && !hideTargetBadge ? knownTargetLabel(tx.to) : null;
  const titleBadge =
    // Approve row: 오른쪽 컬럼에 이미 토큰 심볼이 prominently 들어가므로
    // 제목 뱃지는 spender(=누구한테 권한을 주는지)를 보여줘서 다른 row들의
    // "어디서/어디에" 패턴과 일관되게 유지한다.
    //   꺼내기/모으기/바꾸기 [Pool V2] → 오른쪽에 토큰 금액
    //   승인             [V2 Router] → 오른쪽에 토큰 + 무제한
    primaryApproval
      ? approveSpenderLabel
      : poolBadge ?? fallbackTargetLabel;

  // Subtitle:
  //   • kinds whose token info already appears on the right (swap / deposit
  //     / withdraw / transfer) → just show time. Showing "TokenA → TokenB"
  //     here would be a duplicate of the amount column.
  //   • approve → 토큰 심볼이 이미 제목 뱃지에 있고, spender는 사용자 질문
  //     ("어떤 토큰 approve인지")과 거리가 먼 정보라 subtitle은 시간만.
  //   • receive / send / contract → keep the counterparty so the user knows
  //     who they're interacting with.
  const hideCounterparty =
    kind === "swap" ||
    kind === "deposit" ||
    kind === "withdraw" ||
    kind === "transfer" ||
    kind === "approve";
  const counterparty =
    kind === "receive"
      ? shortenAddress(tx.from)
      : tx.to
      ? shortenAddress(tx.to)
      : "-";
  const subtitle = hideCounterparty
    ? formatWhen(tx.timeStamp)
    : `${kind === "receive" ? "from " : "to "}${counterparty} · ${formatWhen(tx.timeStamp)}`;

  const href = `${STABLENET_TESTNET.explorer}/tx/${tx.hash}`;

  // Right-column content. Priority:
  //   1) Approved token (for 승인 — emphasise the token symbol; 무제한/금액은 보조)
  //   2) Token movements (most informative — "100 TokenA" / "-100 TokenA + 200 TokenB")
  //   3) Native value (for plain native transfer)
  //   4) Truncated tx hash (empty contract calls)
  const renderRightColumn = () => {
    if (primaryApproval) {
      // 제목 옆에도 토큰 심볼 뱃지가 붙지만, 우측 컬럼에서도 "어떤 토큰을
      // approve 했는지"가 우선 정보. 금액(또는 무제한)은 한 단계 낮춰서
      // 보조 정보로 표시한다.
      return (
        <div className="flex flex-col items-end gap-0.5">
          <p className="text-[14px] font-bold text-neutral-900 leading-tight">
            {primaryApproval.symbol}
          </p>
          <p className="text-[11px] text-neutral-400 tabular-nums leading-tight">
            {primaryApproval.isUnlimited
              ? "무제한"
              : formatAmount(primaryApproval.amount, primaryApproval.decimals)}
          </p>
        </div>
      );
    }
    if (displayMoves.length > 0) {
      return (
        <div className="flex flex-col items-end gap-0.5">
          {displayMoves.map((m, i) => {
            const isIn = m.direction === "in";
            return (
              <p
                key={`${m.token}-${m.direction}-${i}`}
                className={cn(
                  "text-[14px] font-bold tabular-nums leading-tight",
                  isIn ? "text-emerald-500" : "text-neutral-900",
                )}
              >
                {isIn ? "+" : "-"}
                {formatAmount(m.amount, m.decimals)}{" "}
                <span className="text-[11px] font-bold text-neutral-500">
                  {m.symbol}
                </span>
              </p>
            );
          })}
        </div>
      );
    }
    if (hasNative) {
      const isIn = kind === "receive";
      return (
        <p
          className={cn(
            "text-[14px] font-bold tabular-nums",
            isIn ? "text-emerald-500" : "text-neutral-900",
          )}
        >
          {isIn ? "+" : "-"}
          {formatNative(tx.value)}{" "}
          <span className="text-[11px] font-bold text-neutral-500">
            {STABLENET_TESTNET.nativeCurrency.symbol}
          </span>
        </p>
      );
    }
    return (
      <p className="text-[12px] text-neutral-300 font-mono">
        {tx.hash.slice(0, 8)}…
      </p>
    );
  };

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "flex items-center gap-3 press hover:bg-neutral-25",
        compact ? "px-5 py-3" : "px-5 py-3.5",
      )}
    >
      <KindIcon kind={kind} error={error} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="text-[14px] font-bold text-neutral-900 truncate">
            {label}
          </p>
          {error && (
            <span className="text-[10px] font-bold text-gain-500 bg-gain-50 px-1.5 py-0.5 rounded">
              실패
            </span>
          )}
          {titleBadge && (
            <span className="text-[10px] font-bold text-neutral-400 bg-neutral-50 px-1.5 py-0.5 rounded truncate">
              {titleBadge}
            </span>
          )}
        </div>
        <p
          className={cn(
            "text-[12px] text-neutral-400 truncate",
            // Monospace only when the subtitle carries a bare address —
            // label-driven subtitles (time, "V3 Router에게") look nicer in
            // the default sans-serif.
            hideCounterparty || primaryApproval ? "" : "font-mono",
          )}
        >
          {subtitle}
        </p>
      </div>
      <div className="text-right shrink-0">{renderRightColumn()}</div>
    </a>
  );
}
