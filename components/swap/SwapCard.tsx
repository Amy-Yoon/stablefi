"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Wallet, ChevronDown, ArrowDownUp, Info, Settings2, AlertTriangle } from "lucide-react";
import { formatUnits, parseUnits, type Abi } from "viem";
import { useQueryClient } from "@tanstack/react-query";
import { useWallet } from "@/context/WalletContext";
import { useToast } from "@/components/ui/Toast";
import { useTokenBalance } from "@/hooks/useToken";
import { CONTRACTS, type Token } from "@/lib/chain";
import type { PoolState } from "@/hooks/usePool";
import { formatToken, formatTokenAmount, cn } from "@/lib/utils";
import { AmountPresets } from "@/components/ui/AmountPresets";
import { ensureAllowance, writeAndWait, friendlyTxError, isStaleWalletError, verifyConnection, type TxStatus } from "@/lib/tx";
import { encodeV3Path, v2Path, rankRoutes, type Route } from "@/lib/routing";
import SwapRouterJson from "@/lib/abi/SwapRouter.json";
import V2RouterJson from "@/lib/abi/V2Router.json";

const SwapRouter = SwapRouterJson as Abi;
const V2Router   = V2RouterJson   as Abi;

const DEFAULT_SLIPPAGE_BPS = 50;   // 0.5%
const SLIPPAGE_PRESETS = [10, 50, 100]; // 0.1%, 0.5%, 1.0%
const SLIPPAGE_MIN_BPS = 1;        // 0.01%
const SLIPPAGE_MAX_BPS = 5000;     // 50% safety ceiling
const SLIPPAGE_WARN_LOW_BPS = 10;  // below = likely to fail
const SLIPPAGE_WARN_HIGH_BPS = 300; // above = high loss risk
const DEADLINE_SECONDS = 600;

// Toss color tokens — used inline so the CTA never goes missing even if
// Tailwind JIT skips a dynamic class during an HMR reload.
const TOSS = {
  primary:      "#3182F6",
  primaryHover: "#1B64DA",
  primaryActive:"#1957B9",
  disabledBg:   "#E5E8EB",
  disabledFg:   "#8B95A1",
} as const;

interface SwapCardProps {
  /** Fallback/default route (used when input is empty — represents best route at size 1). */
  route: Route;
  /** All pool states — needed to re-rank routes by price-impact at the current input amount. */
  pools: PoolState[];
  fromToken: Token;
  toToken: Token;
  onPickFrom: () => void;
  onPickTo: () => void;
  onFlip: () => void;
}

type CtaState = "connect" | "enter-amount" | "over-balance" | "ready" | "loading";

export function SwapCard({ route, pools, fromToken, toToken, onPickFrom, onPickTo, onFlip }: SwapCardProps) {
  const { isConnected, openPicker, address, disconnect } = useWallet();
  const { toast } = useToast();

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [txStatus, setTxStatus] = useState<TxStatus | null>(null);
  const [pressed, setPressed] = useState(false);
  const [hover, setHover] = useState(false);
  const [slippageBps, setSlippageBps] = useState<number>(DEFAULT_SLIPPAGE_BPS);
  const [showSettings, setShowSettings] = useState(false);
  const [customSlippageInput, setCustomSlippageInput] = useState("");
  const queryClient = useQueryClient();

  const { data: balanceRaw } = useTokenBalance(
    fromToken.address,
    address as `0x${string}` | undefined,
  );
  const balanceHuman = balanceRaw
    ? Number(formatUnits(balanceRaw, fromToken.decimals))
    : 0;

  // Whenever the fromToken changes (flip, token picker), clear the input.
  // Stale amounts don't make sense in the new context: user's balance in the
  // new token is different, rate shown is different — dragging the old number
  // into the new row would mislead.
  useEffect(() => {
    setInput("");
  }, [fromToken.address]);

  const inNum  = parseFloat(input) || 0;
  const exceedsBalance = inNum > balanceHuman;

  // Re-rank all routes at the current input size. V2 pools suffer x·y=k
  // price impact that grows with trade size, while V3 (concentrated
  // liquidity) barely moves — but only if V3's L at the current tick is
  // actually deeper than V2's √(r0·r1). On shallow V3 pools the winner
  // can flip back to V2 even at large inputs. We keep the full ranking so
  // the UI can show the runner-up for transparency.
  const rankedRoutes = useMemo(() => {
    const size = inNum > 0 ? inNum : 1;
    return rankRoutes(pools, fromToken, toToken, size);
  }, [pools, fromToken, toToken, inNum]);

  const effectiveRoute = rankedRoutes[0] ?? route;

  const rateOutPerIn = effectiveRoute.rate;
  const isMultiHop   = effectiveRoute.hops.length > 1;

  // outNum is the simulated post-fee, post-impact expected output — this is
  // what the user actually receives. By using estimatedOut directly we avoid
  // two old bugs:
  //   1. Multi-hop revert when cumulative fee > slippage (gross rate × input
  //      overstated the output; amountOutMinimum couldn't be satisfied).
  //   2. Large V2 swap overstatement from ignoring price impact.
  const outNum = inNum > 0 ? effectiveRoute.estimatedOut : 0;

  // Route fee: single-hop = pool.fee pips; multi-hop = compounded across hops.
  // Both V3 pips (1e-6) and routing.feeFraction (0..1) normalize to percent here.
  const feePct      = effectiveRoute.feeFraction * 100;
  const feeAmount   = inNum * effectiveRoute.feeFraction;
  const slippagePct = slippageBps / 100;
  const minReceived = outNum * (1 - slippageBps / 10000);
  const slippageWarning: "low" | "high" | null =
    slippageBps < SLIPPAGE_WARN_LOW_BPS   ? "low"
    : slippageBps > SLIPPAGE_WARN_HIGH_BPS ? "high"
    : null;

  const applyPresetSlippage = (bps: number) => {
    setSlippageBps(bps);
    setCustomSlippageInput("");
  };

  const applyCustomSlippage = (raw: string) => {
    setCustomSlippageInput(raw);
    const pct = parseFloat(raw);
    if (isNaN(pct)) return;
    const bps = Math.round(pct * 100);
    if (bps < SLIPPAGE_MIN_BPS || bps > SLIPPAGE_MAX_BPS) return;
    setSlippageBps(bps);
  };

  const handleMax = () => {
    if (!balanceRaw) return;
    setInput(formatUnits(balanceRaw, fromToken.decimals));
  };

  // 25/50/75 quick pills. 100 is handled by handleMax() (네이티브면 가스 여유분
  // 남길 수 있도록 분기 여지 남김). 정수로 맞춰서 안전한 문자열 변환.
  const handlePercent = (pct: number) => {
    if (!balanceRaw) return;
    if (pct >= 100) { handleMax(); return; }
    const part = (balanceRaw * BigInt(pct)) / 100n;
    setInput(formatUnits(part, fromToken.decimals));
  };

  const handleConfirm = async () => {
    if (!isConnected) { openPicker(); return; }
    if (inNum === 0 || exceedsBalance) return;
    if (!address) { toast("지갑 주소를 확인할 수 없어요", "error"); return; }

    setLoading(true);
    setTxStatus(null);
    try {
      const amountIn = parseUnits(input, fromToken.decimals);

      // Approve spender depends on the router we'll call. V3 single/multi
      // both hit v3Router; V2 single/multi both hit v2Router. They're
      // independent — user may need to approve the same token twice if they
      // switch between versions, but only once per (token, router) pair since
      // we request unlimited allowance.
      const spender =
        effectiveRoute.version === "v3" ? CONTRACTS.v3Router : CONTRACTS.v2Router;

      await ensureAllowance({
        token: fromToken.address,
        owner: address as `0x${string}`,
        spender,
        amount: amountIn,
        decimals: fromToken.decimals,
        onStatus: setTxStatus,
      });

      const expectedOut = parseUnits(
        outNum.toFixed(toToken.decimals),
        toToken.decimals,
      );
      const slippageBpsBn = BigInt(slippageBps);
      const amountOutMinimum =
        (expectedOut * (10000n - slippageBpsBn)) / 10000n;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);

      if (effectiveRoute.kind === "v3-single") {
        const hop = effectiveRoute.hops[0];
        await writeAndWait({
          account: address as `0x${string}`,
          address: CONTRACTS.v3Router,
          abi: SwapRouter,
          functionName: "exactInputSingle",
          args: [{
            tokenIn: fromToken.address,
            tokenOut: toToken.address,
            fee: hop.fee,
            recipient: address as `0x${string}`,
            deadline,
            amountIn,
            amountOutMinimum,
            sqrtPriceLimitX96: 0n,
          }],
          onStatus: setTxStatus,
        });
      } else if (effectiveRoute.kind === "v3-multi") {
        // v3-multi: SwapRouter.exactInput with encoded path bytes.
        // Path format: tokenIn(20) + fee(3) + tokenMid(20) + fee(3) + tokenOut(20)
        const path = encodeV3Path(effectiveRoute.hops);
        await writeAndWait({
          account: address as `0x${string}`,
          address: CONTRACTS.v3Router,
          abi: SwapRouter,
          functionName: "exactInput",
          args: [{
            path,
            recipient: address as `0x${string}`,
            deadline,
            amountIn,
            amountOutMinimum,
          }],
          onStatus: setTxStatus,
        });
      } else {
        // v2-single or v2-multi: UniswapV2Router02.swapExactTokensForTokens.
        // Path is an address[] — [tokenIn, tokenOut] for single, with
        // intermediates inserted for multi-hop.
        await writeAndWait({
          account: address as `0x${string}`,
          address: CONTRACTS.v2Router,
          abi: V2Router,
          functionName: "swapExactTokensForTokens",
          args: [
            amountIn,
            amountOutMinimum,
            v2Path(effectiveRoute),
            address as `0x${string}`,
            deadline,
          ],
          onStatus: setTxStatus,
        });
      }

      toast(
        `${formatToken(inNum, fromToken.symbol, fromToken.decimals)} → ${formatToken(outNum, toToken.symbol, toToken.decimals)}`,
        "success",
      );
      setInput("");
      queryClient.invalidateQueries({ queryKey: ["tokenBalance"] });
      queryClient.invalidateQueries({ queryKey: ["pool"] });
      // 바꾸기도 거래내역에 찍혀야 하므로 같이 invalidate.
      queryClient.invalidateQueries({ queryKey: ["activity"] });
    } catch (e: any) {
      toast(friendlyTxError(e), "error");
      // Only disconnect when we're CERTAIN the session is gone. Previously we
      // dropped the session on any ambiguous error (wallet busy, chain hiccup),
      // which kicked users out mid-swap. Now we double-check with eth_accounts
      // and only disconnect if the wallet itself reports no authorized account.
      if (isStaleWalletError(e)) {
        const stillConnected = await verifyConnection();
        if (!stillConnected) disconnect();
      }
    } finally {
      setLoading(false);
      setTxStatus(null);
    }
  };

  // ── CTA state ────────────────────────────────────────────────────────────────
  const ctaState: CtaState =
    loading          ? "loading"
    : !isConnected   ? "connect"
    : exceedsBalance ? "over-balance"
    : inNum === 0    ? "enter-amount"
    :                  "ready";

  const ctaLabel = useMemo(() => {
    if (ctaState === "loading")       return txStatus?.label ?? "처리 중...";
    if (ctaState === "connect")       return "지갑 연결하기";
    if (ctaState === "over-balance")  return "잔액이 부족해요";
    if (ctaState === "enter-amount")  return "금액을 입력해주세요";
    return "바꾸기";
  }, [ctaState, txStatus]);

  const isActionable = ctaState === "connect" || ctaState === "ready";
  const isDisabled   = ctaState === "enter-amount" || ctaState === "over-balance";

  // Inline style ensures colors render regardless of JIT/HMR timing.
  const ctaStyle: React.CSSProperties = isDisabled
    ? { backgroundColor: TOSS.disabledBg, color: TOSS.disabledFg, cursor: "not-allowed" }
    : {
        backgroundColor:
          pressed ? TOSS.primaryActive
          : hover ? TOSS.primaryHover
          : TOSS.primary,
        color: "#FFFFFF",
        cursor: ctaState === "loading" ? "wait" : "pointer",
        transform: pressed ? "scale(0.98)" : "scale(1)",
        transition: "background-color 120ms ease, transform 100ms ease",
      };

  const showRoute = inNum > 0;
  const disabledAttr = !isActionable; // disable for loading / enter / over states

  return (
    <div className="w-full space-y-2">

      {/* ── Settings: slippage ── */}
      <div className="flex items-center justify-end">
        <button
          onClick={() => setShowSettings((v) => !v)}
          aria-expanded={showSettings}
          className={cn(
            "flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px] font-bold press",
            showSettings
              ? "bg-toss-50 text-toss-500"
              : "text-neutral-500 hover:bg-neutral-50",
          )}
        >
          <Settings2 size={12} />
          <span>슬리피지 <span className="tabular-nums">{slippagePct}%</span></span>
        </button>
      </div>

      {showSettings && (
        <div className="rounded-toss bg-white p-4">
          <p className="text-[12px] font-bold text-neutral-900 mb-2">슬리피지 허용 범위</p>
          <p className="text-[11px] text-neutral-500 leading-relaxed mb-3">
            실제 체결가가 예상가와 얼마나 차이나도 되는지 정해요.
            작을수록 체결 실패 확률이 늘고, 클수록 손실 위험이 커져요.
          </p>

          <div className="flex gap-1.5">
            {SLIPPAGE_PRESETS.map((bps) => (
              <button
                key={bps}
                onClick={() => applyPresetSlippage(bps)}
                className={cn(
                  "flex-1 h-11 rounded-toss text-[13px] font-bold tabular-nums press",
                  slippageBps === bps && customSlippageInput === ""
                    ? "bg-toss-500 text-white"
                    : "bg-neutral-50 text-neutral-700 hover:bg-neutral-100",
                )}
                style={
                  slippageBps === bps && customSlippageInput === ""
                    ? { backgroundColor: TOSS.primary, color: "#FFFFFF" }
                    : undefined
                }
              >
                {bps / 100}%
              </button>
            ))}
            <div className="relative flex-1">
              <input
                type="number"
                inputMode="decimal"
                min="0.01"
                max="50"
                step="0.01"
                placeholder="직접"
                value={customSlippageInput}
                onChange={(e) => applyCustomSlippage(e.target.value)}
                className={cn(
                  "w-full h-11 rounded-toss bg-neutral-50 text-center text-[13px] font-bold tabular-nums outline-none pr-6",
                  "placeholder:text-neutral-400 placeholder:font-medium",
                  "focus:bg-white focus:ring-2 focus:ring-toss-500",
                  customSlippageInput !== "" && "text-toss-500 bg-toss-50",
                )}
              />
              <span
                className={cn(
                  "absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] font-bold pointer-events-none",
                  customSlippageInput !== "" ? "text-toss-500" : "text-neutral-400",
                )}
              >
                %
              </span>
            </div>
          </div>

          {slippageWarning && (
            <div
              className={cn(
                "mt-3 flex items-start gap-1.5 rounded-toss px-3 py-2 text-[11px] leading-relaxed",
                slippageWarning === "low"
                  ? "bg-neutral-50 text-neutral-600"
                  : "bg-gain-50 text-gain-600",
              )}
            >
              <AlertTriangle size={12} className="shrink-0 mt-0.5" />
              <span>
                {slippageWarning === "low"
                  ? "슬리피지가 너무 낮으면 체결에 실패할 수 있어요"
                  : "슬리피지가 너무 높으면 불리한 가격에 체결될 수 있어요"}
              </span>
            </div>
          )}
        </div>
      )}

      {/* ── From ── */}
      <TokenIOCard
        role="from"
        token={fromToken}
        balanceHuman={balanceHuman}
        balanceLoaded={!!balanceRaw || !address}
        value={input}
        onChange={setInput}
        onMax={handleMax}
        onPercent={handlePercent}
        showMax={isConnected}
        onPickToken={onPickFrom}
        exceedsBalance={exceedsBalance}
      />

      {/* ── Flip ── */}
      <div className="relative h-0">
        <button
          onClick={onFlip}
          aria-label="방향 바꾸기"
          className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 top-0 w-11 h-11 rounded-full bg-white border-[3px] border-[#F2F4F6] flex items-center justify-center text-neutral-400 hover:text-toss-500 hover:rotate-180 transition-all duration-200 z-10"
        >
          <ArrowDownUp size={16} />
        </button>
      </div>

      {/* ── To ── */}
      <TokenIOCard
        role="to"
        token={toToken}
        value={outNum > 0 ? formatTokenAmount(outNum, toToken.decimals) : ""}
        readOnly
        onPickToken={onPickTo}
      />

      {/* ── Route & fees ── compact, only after user enters an amount */}
      <div
        className={cn(
          "mt-3 rounded-toss bg-white overflow-hidden transition-all",
          showRoute ? "opacity-100" : "opacity-60",
        )}
      >
        <div className="px-4 py-3 space-y-2 text-[12px]">
          <Row
            label={
              <>
                <Info size={12} className="text-neutral-400" />
                <span>경로</span>
              </>
            }
            value={
              <>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded font-bold"
                  style={
                    effectiveRoute.version === "v3"
                      ? { backgroundColor: "#EEF2FF", color: "#4F46E5" }  // V3: indigo (concentrated, sharper)
                      : { backgroundColor: "#FEF3C7", color: "#B45309" }  // V2: amber (classic AMM)
                  }
                >
                  {effectiveRoute.version.toUpperCase()}{isMultiHop ? ` · ${effectiveRoute.hops.length}홉` : ""}
                </span>
                <span className="text-neutral-700 font-bold truncate">
                  {effectiveRoute.path.map((t) => t.symbol).join(" → ")}
                </span>
                <span className="text-neutral-300">·</span>
                <span className="text-neutral-700 font-bold tabular-nums">
                  {feePct.toFixed(2)}%
                </span>
              </>
            }
          />

          <Row
            label="교환비"
            value={
              <span className="text-neutral-700 font-bold tabular-nums truncate">
                1 {fromToken.symbol} = {formatTokenAmount(rateOutPerIn, toToken.decimals)} {toToken.symbol}
              </span>
            }
          />

          <Row
            label="수수료"
            value={
              <span
                className={cn(
                  "font-bold tabular-nums",
                  showRoute ? "text-neutral-700" : "text-neutral-300",
                )}
              >
                {showRoute ? formatTokenAmount(feeAmount, fromToken.decimals) : "0"} {fromToken.symbol}
              </span>
            }
          />

          <Row
            label="최소 수령"
            hint={`슬리피지 ${slippagePct}% 반영`}
            value={
              <span
                className={cn(
                  "font-bold tabular-nums",
                  showRoute ? "text-neutral-900" : "text-neutral-300",
                )}
              >
                {showRoute ? formatTokenAmount(minReceived, toToken.decimals) : "0"} {toToken.symbol}
              </span>
            }
          />
        </div>

      </div>

      {/* ── CTA ── inline-style colors so it's always visible */}
      <button
        onClick={handleConfirm}
        disabled={disabledAttr}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => { setHover(false); setPressed(false); }}
        onMouseDown={() => setPressed(true)}
        onMouseUp={() => setPressed(false)}
        onTouchStart={() => setPressed(true)}
        onTouchEnd={() => setPressed(false)}
        style={ctaStyle}
        className="w-full h-14 rounded-toss text-[15px] font-bold flex items-center justify-center gap-2 mt-3 select-none"
      >
        {ctaState === "loading"
          ? <><Loader2 size={16} className="animate-spin" /> {ctaLabel}</>
          : ctaLabel}
      </button>
    </div>
  );
}

// ── Row helper for info card ─────────────────────────────────────────────────

function Row({
  label, value, hint,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-1.5 text-neutral-500 shrink-0">
        {label}
        {hint && <span className="text-[10px] text-neutral-400">({hint})</span>}
      </div>
      <div className="flex items-center gap-1.5 min-w-0">{value}</div>
    </div>
  );
}

// ── TokenIOCard ──────────────────────────────────────────────────────────────

interface TokenIOCardProps {
  role: "from" | "to";
  token: Token;
  balanceHuman?: number;
  balanceLoaded?: boolean;
  value: string;
  onChange?: (v: string) => void;
  onMax?: () => void;
  onPercent?: (pct: number) => void;
  readOnly?: boolean;
  showMax?: boolean;
  onPickToken?: () => void;
  exceedsBalance?: boolean;
}

function TokenIOCard({
  role, token, balanceHuman, balanceLoaded, value, onChange, onMax, onPercent, readOnly, showMax, onPickToken, exceedsBalance,
}: TokenIOCardProps) {
  return (
    <div className="bg-white rounded-toss-lg px-5 py-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[12px] font-medium text-neutral-500">
          {role === "from" ? "보내는 토큰" : "받는 토큰"}
        </span>
        {role === "from" && balanceLoaded && (
          <div className="flex items-center gap-1.5 text-[12px] text-neutral-400">
            <Wallet size={12} />
            <span className="tabular-nums">
              {formatToken(balanceHuman ?? 0, token.symbol, token.decimals)}
            </span>
            {showMax && (balanceHuman ?? 0) > 0 && (
              <AmountPresets onPercent={onPercent} onMax={onMax} />
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={onPickToken}
          disabled={!onPickToken}
          className={cn(
            "flex items-center gap-2 shrink-0 pl-2.5 pr-3 py-2 rounded-full bg-neutral-50 press",
            onPickToken && "hover:bg-neutral-100 cursor-pointer",
          )}
        >
          <span className="w-6 h-6 rounded-full bg-white flex items-center justify-center text-sm">
            {token.logoUrl ?? "🪙"}
          </span>
          <span className="text-[14px] font-bold text-neutral-900">{token.symbol}</span>
          {onPickToken && <ChevronDown size={14} className="text-neutral-400" />}
        </button>
        <div className="flex-1 text-right min-w-0">
          {readOnly ? (
            <p className={cn(
              "text-[32px] font-black tracking-tight tabular-nums truncate leading-none",
              value ? "text-neutral-900" : "text-neutral-200"
            )}>
              {value || "0"}
            </p>
          ) : (
            <input
              type="number"
              inputMode="decimal"
              min="0"
              placeholder="0"
              value={value}
              onChange={(e) => onChange?.(e.target.value)}
              className={cn(
                "w-full bg-transparent text-right text-[32px] font-black placeholder:text-neutral-200 outline-none tabular-nums tracking-tight leading-none",
                exceedsBalance ? "text-gain-500" : "text-neutral-900",
              )}
            />
          )}
        </div>
      </div>
    </div>
  );
}
