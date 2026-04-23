"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X, PiggyBank, ChevronDown, Plus, Layers } from "lucide-react";
import { encodeFunctionData, formatUnits, parseUnits, type Abi } from "viem";
import { useQueryClient } from "@tanstack/react-query";
import type { Pool } from "@/components/pool/PoolList";
import { useWallet } from "@/context/WalletContext";
import { useToast } from "@/components/ui/Toast";
import { useTokenBalance } from "@/hooks/useToken";
import { usePool } from "@/hooks/usePool";
import { formatToken, formatTokenAmount, formatWKRC, cn } from "@/lib/utils";
import { PrimaryButton } from "@/components/ui/PrimaryButton";
import { AmountPresets } from "@/components/ui/AmountPresets";
import {
  RANGE_PRESETS,
  resolvePreset,
  resolveCustomRange,
  formatPriceCompact,
  computeV3Amount0,
  computeV3Amount1,
  tickToPrice,
  MIN_TICK,
  MAX_TICK,
  type RangePresetKey,
} from "@/lib/v3Range";
import { CONTRACTS } from "@/lib/chain";
import { ensureAllowance, writeAndWait, friendlyTxError, type TxStatus } from "@/lib/tx";
import PositionManagerJson from "@/lib/abi/PositionManager.json";
import V2RouterJson from "@/lib/abi/V2Router.json";

const PositionManager = PositionManagerJson as Abi;
const V2Router = V2RouterJson as Abi;

// 0.5% slippage for amount0Min/amount1Min on mint; 10-minute deadline.
const SLIPPAGE_BPS = 50n;
const DEADLINE_SECONDS = 600;

type Mode = "deposit" | "withdraw";

interface PoolModalProps {
  pool: Pool;
  mode: Mode;
  onClose: () => void;
  onSwitchMode: (m: Mode) => void;
}

export function PoolModal({ pool, mode, onClose, onSwitchMode }: PoolModalProps) {
  const { isConnected, openPicker, address } = useWallet();
  const { toast } = useToast();

  // Live pool state (for rate calculation)
  const { data: live } = usePool({ address: pool.address, version: pool.version });

  // Balances for each side
  const { data: bal0 } = useTokenBalance(pool.token0.address, address as `0x${string}` | undefined);
  const { data: bal1 } = useTokenBalance(pool.token1.address, address as `0x${string}` | undefined);

  const [amount0, setAmount0] = useState("");
  const [amount1, setAmount1] = useState("");
  // Which side the user is actively editing — the OTHER side is derived.
  // Swapping the driver lets either input feel equally "first-class" rather
  // than locking one as readonly.
  const [driver, setDriver] = useState<0 | 1>(0);
  const [percent, setPercent] = useState(100);
  const [loading, setLoading] = useState(false);
  const [txStatus, setTxStatus] = useState<TxStatus | null>(null);
  const queryClient = useQueryClient();

  // Show each individual NFT slice's range/amount breakdown in the withdraw
  // tab. For V3 we default to OPEN because the range (어떤 가격 구간에 넣었는지)
  // is the whole point of V3 — hiding it feels like withholding info. For V2
  // there's no range concept so we keep it closed unless the user opts in.
  const [showSliceDetails, setShowSliceDetails] = useState(pool.version === "v3");

  // V3 range selection — default to "표준" (±10%)
  const [rangeKey, setRangeKey] = useState<RangePresetKey>("standard");
  // Custom range inputs (only used when rangeKey === "custom"). Stored as
  // strings so the user can clear/retype freely; parsed on each render.
  const [customLower, setCustomLower] = useState("");
  const [customUpper, setCustomUpper] = useState("");

  // V3 multi-position routing.
  // ─ 꺼내기: which NFT slice the user is withdrawing from. null = all slices
  //   (only valid when there's a single slice; we force-pick the first one
  //   otherwise to prevent blanket withdrawals from unintended positions).
  // ─ 맡기기: which existing NFT the user is adding to. null = 신규 포지션
  //   (mint). bigint = 기존 포지션에 추가 (increaseLiquidity) — range is
  //   locked to that position's ticks and the range picker is hidden.
  const v3Slices = pool.version === "v3" ? (pool.myPositionSlices ?? []) : [];
  const hasMultipleV3 = pool.version === "v3" && v3Slices.length > 1;
  const hasAnyV3 = pool.version === "v3" && v3Slices.length > 0;

  const [withdrawTokenId, setWithdrawTokenId] = useState<bigint | null>(
    // Default to the first slice when V3 has multiple — forces an explicit
    // choice rather than silently draining every position at the same %.
    hasMultipleV3 ? v3Slices[0].tokenId : null,
  );
  const [depositTargetId, setDepositTargetId] = useState<bigint | null>(null);

  // The slice the user is adding to (only V3, only when 기존 포지션에 추가).
  const depositTargetSlice = useMemo(() => {
    if (depositTargetId === null) return null;
    return v3Slices.find((s) => s.tokenId === depositTargetId) ?? null;
  }, [depositTargetId, v3Slices]);

  // useState initializer only runs on mount — if slices hadn't loaded yet OR
  // the selected slice gets withdrawn, we'd silently fall back to "all slices"
  // which is the exact behavior we're trying to prevent. Re-sync whenever the
  // slice list changes: if V3 has >1 positions and we don't have a valid
  // selection, default to the first one; if selection no longer exists, clear
  // and let the defaulting logic below re-apply.
  useEffect(() => {
    if (pool.version !== "v3") return;
    if (v3Slices.length <= 1) {
      // 단일 슬라이스면 null로 두고 fallback(전체)에 의존해도 안전.
      if (withdrawTokenId !== null) setWithdrawTokenId(null);
      return;
    }
    const stillExists = v3Slices.some((s) => s.tokenId === withdrawTokenId);
    if (!stillExists) setWithdrawTokenId(v3Slices[0].tokenId);
  }, [pool.version, v3Slices, withdrawTokenId]);

  // If the user picks "기존 포지션에 추가" but that NFT disappears (e.g., it
  // was fully withdrawn in another flow), silently revert to 신규 포지션.
  useEffect(() => {
    if (depositTargetId === null) return;
    const stillExists = v3Slices.some((s) => s.tokenId === depositTargetId);
    if (!stillExists) setDepositTargetId(null);
  }, [v3Slices, depositTargetId]);

  // Portal-to-body guard: `document` doesn't exist on first render (SSR /
  // hydration), so we render nothing server-side and flip to true on mount.
  // Portaling is necessary because otherwise the modal is a DOM child of
  // <main>, and any ancestor with a transform/filter creates a new containing
  // block that would clip `fixed inset-0` — letting the Navbar/NetworkBanner
  // bleed through the dim. Appending to <body> makes the dim truly viewport-
  // sized regardless of page layout.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // Lock body scroll while modal is open so the background can't shift
  // behind the backdrop (especially on iOS Safari overscroll).
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  const range = useMemo(() => {
    if (!live || live.version !== "v3" || live.tickSpacing === undefined) return null;

    // increaseLiquidity 경로: 기존 NFT의 tick을 그대로 사용한다.
    // 레인지 선택 UI는 숨겨져 있으므로 rangeKey/custom* 값은 무시하고,
    // 사용자가 고른 포지션의 tickLower/tickUpper를 √p 계산의 입력으로 넘긴다.
    if (depositTargetSlice) {
      return {
        lowerTick: depositTargetSlice.tickLower,
        upperTick: depositTargetSlice.tickUpper,
        lowerPrice: tickToPrice(
          depositTargetSlice.tickLower,
          live.token0.decimals,
          live.token1.decimals,
        ),
        upperPrice: tickToPrice(
          depositTargetSlice.tickUpper,
          live.token0.decimals,
          live.token1.decimals,
        ),
      };
    }

    if (rangeKey === "custom") {
      const lo = parseFloat(customLower);
      const hi = parseFloat(customUpper);
      return resolveCustomRange(
        lo, hi,
        live.tickSpacing,
        live.token0.decimals,
        live.token1.decimals,
      );
    }
    const preset = RANGE_PRESETS.find((p) => p.key === rangeKey)!;
    return resolvePreset(
      preset,
      live.price1Per0,
      live.tickSpacing,
      live.token0.decimals,
      live.token1.decimals,
    );
  }, [live, rangeKey, customLower, customUpper, depositTargetSlice]);

  // Seed the custom inputs with a reasonable default (±10% of spot) the first
  // time the user lands on "직접" so they're not staring at empty fields.
  const pickCustom = () => {
    setRangeKey("custom");
    if (!customLower && !customUpper && live) {
      setCustomLower(live.price1Per0 ? String(+(live.price1Per0 * 0.9).toPrecision(6)) : "");
      setCustomUpper(live.price1Per0 ? String(+(live.price1Per0 * 1.1).toPrecision(6)) : "");
    }
  };

  // The non-driver side is DERIVED from: driver amount + range + live pool.
  //
  // Uniswap V3 positions deposit in a ratio determined by sqrtPriceX96 and
  // tick boundaries — NOT spot price. Using spot (price1Per0) for non-full
  // ranges makes the position manager revert "Price slippage check" because
  // the limiting side falls below amount{0,1}Min. computeV3Amount{0,1} apply
  // the correct √p formula; one drives the other.
  //
  // Rerunning this when `range` changes re-derives against the new boundaries
  // automatically — prevents stale ratio from a previously-selected preset.
  useEffect(() => {
    if (!live) return;
    // V3는 √p 계산이 필요해 range가 있어야 동작. V2는 range 개념 자체가
    // 없으므로(전체 구간) range 없이도 reserves 비율로 바로 계산.
    // 예전에는 `!range`로 바로 return 했는데, 이 탓에 V2 맡기기에서 한쪽
    // 값을 넣어도 반대쪽이 비어서 "두 토큰 모두 입력해주세요" 에러에 막히는
    // 이슈가 있었음.
    if (live.version === "v3" && !range) return;
    if (driver === 0) {
      const n = parseFloat(amount0) || 0;
      if (n === 0) { setAmount1(""); return; }
      if (live.version !== "v3" || live.sqrtPriceX96 === undefined) {
        const a1 = n * live.price1Per0;
        setAmount1(a1 ? trimDerived(a1, live.token1.decimals) : "");
        return;
      }
      const a1 = computeV3Amount1(
        n, live.sqrtPriceX96,
        range!.lowerTick, range!.upperTick,
        live.token0.decimals, live.token1.decimals,
      );
      // NaN → price above range: token0 can't drive; leave token1 blank.
      if (!Number.isFinite(a1)) { setAmount1(""); return; }
      setAmount1(a1 > 0 ? trimDerived(a1, live.token1.decimals) : "0");
    } else {
      const n = parseFloat(amount1) || 0;
      if (n === 0) { setAmount0(""); return; }
      if (live.version !== "v3" || live.sqrtPriceX96 === undefined) {
        const a0 = live.price1Per0 > 0 ? n / live.price1Per0 : 0;
        setAmount0(a0 ? trimDerived(a0, live.token0.decimals) : "");
        return;
      }
      const a0 = computeV3Amount0(
        n, live.sqrtPriceX96,
        range!.lowerTick, range!.upperTick,
        live.token0.decimals, live.token1.decimals,
      );
      // NaN → price below range: token1 can't drive; leave token0 blank.
      if (!Number.isFinite(a0)) { setAmount0(""); return; }
      setAmount0(a0 > 0 ? trimDerived(a0, live.token0.decimals) : "0");
    }
  }, [amount0, amount1, driver, live, range]);

  const editToken0 = (v: string) => { setDriver(0); setAmount0(v); };
  const editToken1 = (v: string) => { setDriver(1); setAmount1(v); };

  // WKRC value: only meaningful if one side is WKRC
  const wkrcOf = (amount: number, side: 0 | 1): number | null => {
    const sym = side === 0 ? pool.token0.symbol : pool.token1.symbol;
    const otherSym = side === 0 ? pool.token1.symbol : pool.token0.symbol;
    if (sym === "WKRC") return amount;
    if (otherSym === "WKRC" && live) {
      const rate = side === 0 ? live.price1Per0 : live.price0Per1;
      return amount * rate;
    }
    return null;
  };

  const a0Num = parseFloat(amount0) || 0;
  const a1Num = parseFloat(amount1) || 0;
  const wkrc0 = wkrcOf(a0Num, 0);
  const wkrc1 = wkrcOf(a1Num, 1);
  const totalWKRC =
    wkrc0 !== null && wkrc1 !== null ? wkrc0 + wkrc1 : null;

  // Position counts if either principal is locked OR fees are uncollected.
  // A fully-withdrawn NFT with owed > 0 is still a legitimate "cash out".
  const hasPosition =
    (!!pool.myDepositedWKRC && pool.myDepositedWKRC > 0) ||
    (!!pool.myEarnedWKRC && pool.myEarnedWKRC > 0);

  // Execute the withdraw flow.
  //
  // V3: for each NFT slice, scale `liquidity` by percent and build a pair of
  // PositionManager calls — decreaseLiquidity (moves amounts into the owed
  // bucket) + collect (sweeps the owed bucket to the user). Bundle all calls
  // across every slice into a single multicall tx so the user only sees one
  // popup regardless of how many positions they hold in this pool.
  //
  // V2: approve LP tokens (pair contract = LP token) to V2Router, then
  // removeLiquidity scaled by percent. Fees are auto-compounded into reserves,
  // so there's no separate collect step.
  //
  // Slippage: we apply the same 0.5% floor as deposit via amount0Min/amount1Min
  // derived from the predicted amounts in slices (which already include the √p
  // math result). For V3, collect's amount0Max/1Max are set to uint128 max so
  // it drains the whole owed bucket.
  const handleWithdraw = async () => {
    const allSlices = pool.myPositionSlices ?? [];
    if (allSlices.length === 0) { toast("꺼낼 포지션이 없어요", "error"); return; }
    if (percent <= 0) { toast("꺼낼 비율을 선택해주세요", "error"); return; }

    // 포지션별 꺼내기 — V3에서 withdrawTokenId가 지정되면 그 하나만 건드린다.
    // V2나 단일 V3 포지션이면 기존처럼 전체를 대상으로 한다.
    const slices =
      pool.version === "v3" && withdrawTokenId !== null
        ? allSlices.filter((s) => s.tokenId === withdrawTokenId)
        : allSlices;
    if (slices.length === 0) {
      toast("선택한 포지션을 찾지 못했어요", "error");
      return;
    }

    setLoading(true);
    setTxStatus(null);
    try {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);
      const MAX_U128 = (1n << 128n) - 1n;
      const pctN = BigInt(percent);

      if (pool.version === "v3") {
        // Build flat bytes[] for PositionManager.multicall.
        const calls: `0x${string}`[] = [];
        for (const slice of slices) {
          const liqToRemove = (slice.liquidity * pctN) / 100n;
          // Skip slices that contribute nothing — they'd revert or waste gas.
          if (liqToRemove > 0n) {
            const minA0 = parseUnits(
              ((slice.amount0 * percent) / 100 * 0.995).toFixed(pool.token0.decimals),
              pool.token0.decimals,
            );
            const minA1 = parseUnits(
              ((slice.amount1 * percent) / 100 * 0.995).toFixed(pool.token1.decimals),
              pool.token1.decimals,
            );
            calls.push(
              encodeFunctionData({
                abi: PositionManager,
                functionName: "decreaseLiquidity",
                args: [{
                  tokenId: slice.tokenId,
                  liquidity: liqToRemove,
                  amount0Min: minA0,
                  amount1Min: minA1,
                  deadline,
                }],
              }),
            );
          }
          // Always collect — this sweeps BOTH the just-freed tokens AND any
          // previously-accrued fees (tokensOwed). Skipping when liqToRemove=0
          // would leave fees stranded on 100%-fee-only withdraws.
          calls.push(
            encodeFunctionData({
              abi: PositionManager,
              functionName: "collect",
              args: [{
                tokenId: slice.tokenId,
                recipient: address as `0x${string}`,
                amount0Max: MAX_U128,
                amount1Max: MAX_U128,
              }],
            }),
          );
        }

        if (calls.length === 0) { toast("꺼낼 수량이 너무 작아요", "error"); return; }

        await writeAndWait({
          account: address as `0x${string}`,
          address: CONTRACTS.v3PositionManager,
          abi: PositionManager,
          functionName: "multicall",
          args: [calls],
          onStatus: setTxStatus,
        });
      } else {
        // V2 — one pair, one LP token = the pair contract itself.
        const slice = slices[0];
        const lpToRemove = (slice.liquidity * pctN) / 100n;
        if (lpToRemove === 0n) { toast("꺼낼 수량이 너무 작아요", "error"); return; }

        const minA0 = parseUnits(
          ((slice.amount0 * percent) / 100 * 0.995).toFixed(pool.token0.decimals),
          pool.token0.decimals,
        );
        const minA1 = parseUnits(
          ((slice.amount1 * percent) / 100 * 0.995).toFixed(pool.token1.decimals),
          pool.token1.decimals,
        );

        // LP token = pair address. Approve V2Router to pull it.
        // V2 LP tokens always have 18 decimals (Uniswap V2 mints ERC20 with 18d).
        await ensureAllowance({
          token: pool.address,
          owner: address as `0x${string}`,
          spender: CONTRACTS.v2Router,
          amount: lpToRemove,
          decimals: 18,
          onStatus: setTxStatus,
        });

        await writeAndWait({
          account: address as `0x${string}`,
          address: CONTRACTS.v2Router,
          abi: V2Router,
          functionName: "removeLiquidity",
          args: [
            pool.token0.address,
            pool.token1.address,
            lpToRemove,
            minA0,
            minA1,
            address as `0x${string}`,
            deadline,
          ],
          onStatus: setTxStatus,
        });
      }

      toast(`꺼내기 완료! ${percent}% 돌려받았어요`, "success");
      // Refresh everything that depends on balances or positions.
      queryClient.invalidateQueries({ queryKey: ["tokenBalance"] });
      queryClient.invalidateQueries({ queryKey: ["pool"] });
      queryClient.invalidateQueries({ queryKey: ["myPositionCount"] });
      queryClient.invalidateQueries({ queryKey: ["myTokenId"] });
      queryClient.invalidateQueries({ queryKey: ["v3Position"] });
      queryClient.invalidateQueries({ queryKey: ["v2LpBalance"] });
      queryClient.invalidateQueries({ queryKey: ["v2LpTotalSupply"] });
      // 거래내역(홈 위젯 + /activity 페이지) 즉시 갱신. staleTime 30s 때문에
      // invalidate 안 하면 방금 낸 tx가 안 보이는 것처럼 착각하기 쉽다.
      queryClient.invalidateQueries({ queryKey: ["activity"] });
      onClose();
    } catch (e: any) {
      toast(friendlyTxError(e), "error");
    } finally {
      setLoading(false);
      setTxStatus(null);
    }
  };

  const handleConfirm = async () => {
    if (!isConnected) { openPicker(); return; }
    if (!address) { toast("지갑 주소를 확인할 수 없어요", "error"); return; }

    if (mode === "withdraw") {
      await handleWithdraw();
      return;
    }

    if (a0Num <= 0 || a1Num <= 0) { toast("두 토큰 모두 입력해주세요", "error"); return; }

    setLoading(true);
    setTxStatus(null);
    try {
      const amount0Desired = parseUnits(amount0, pool.token0.decimals);
      const amount1Desired = parseUnits(
        a1Num.toFixed(pool.token1.decimals),
        pool.token1.decimals,
      );
      const amount0Min = (amount0Desired * (10000n - SLIPPAGE_BPS)) / 10000n;
      const amount1Min = (amount1Desired * (10000n - SLIPPAGE_BPS)) / 10000n;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);

      // Spender differs by version: V3 deposits go through PositionManager,
      // V2 deposits go through Router (router pulls tokens via transferFrom).
      const spender =
        pool.version === "v3" ? CONTRACTS.v3PositionManager : CONTRACTS.v2Router;

      // Sequential approvals — MetaMask can't queue two popups at once.
      await ensureAllowance({
        token: pool.token0.address,
        owner: address as `0x${string}`,
        spender,
        amount: amount0Desired,
        decimals: pool.token0.decimals,
        onStatus: setTxStatus,
      });
      await ensureAllowance({
        token: pool.token1.address,
        owner: address as `0x${string}`,
        spender,
        amount: amount1Desired,
        decimals: pool.token1.decimals,
        onStatus: setTxStatus,
      });

      if (pool.version === "v3") {
        if (!range) { toast("수익 구간을 불러오는 중이에요", "error"); return; }
        // 기존 포지션에 추가 → increaseLiquidity(tokenId,...)
        // 신규 포지션 → mint(...)
        // 기존 포지션은 이미 tick이 결정돼 있으므로 range picker를 스킵하고
        // √p 계산은 slice의 ticks로 수행된 amounts를 그대로 쓴다.
        if (depositTargetId !== null) {
          await writeAndWait({
            account: address as `0x${string}`,
            address: CONTRACTS.v3PositionManager,
            abi: PositionManager,
            functionName: "increaseLiquidity",
            args: [{
              tokenId: depositTargetId,
              amount0Desired,
              amount1Desired,
              amount0Min,
              amount1Min,
              deadline,
            }],
            onStatus: setTxStatus,
          });
        } else {
          await writeAndWait({
            account: address as `0x${string}`,
            address: CONTRACTS.v3PositionManager,
            abi: PositionManager,
            functionName: "mint",
            args: [{
              token0: pool.token0.address,
              token1: pool.token1.address,
              fee: pool.fee,
              tickLower: range.lowerTick,
              tickUpper: range.upperTick,
              amount0Desired,
              amount1Desired,
              amount0Min,
              amount1Min,
              recipient: address as `0x${string}`,
              deadline,
            }],
            onStatus: setTxStatus,
          });
        }
      } else {
        // V2 addLiquidity. The router will pull the spot ratio at TX time;
        // amountAMin/amountBMin protect against ratio drift between quote
        // and execution. No concentrated range — V2 is full-range by design.
        await writeAndWait({
          account: address as `0x${string}`,
          address: CONTRACTS.v2Router,
          abi: V2Router,
          functionName: "addLiquidity",
          args: [
            pool.token0.address,
            pool.token1.address,
            amount0Desired,
            amount1Desired,
            amount0Min,
            amount1Min,
            address as `0x${string}`,
            deadline,
          ],
          onStatus: setTxStatus,
        });
      }

      toast(
        `맡기기 완료! ${formatToken(a0Num, pool.token0.symbol, pool.token0.decimals)} + ${formatToken(a1Num, pool.token1.symbol, pool.token1.decimals)}`,
        "success",
      );
      queryClient.invalidateQueries({ queryKey: ["tokenBalance"] });
      queryClient.invalidateQueries({ queryKey: ["pool"] });
      // New V3 NFT or new V2 LP balance — refresh position readers.
      queryClient.invalidateQueries({ queryKey: ["myPositionCount"] });
      queryClient.invalidateQueries({ queryKey: ["myTokenId"] });
      queryClient.invalidateQueries({ queryKey: ["v3Position"] });
      queryClient.invalidateQueries({ queryKey: ["v2LpBalance"] });
      queryClient.invalidateQueries({ queryKey: ["v2LpTotalSupply"] });
      // 거래내역(홈 위젯 + /activity 페이지) 즉시 갱신.
      queryClient.invalidateQueries({ queryKey: ["activity"] });
      onClose();
    } catch (e: any) {
      toast(friendlyTxError(e), "error");
    } finally {
      setLoading(false);
      setTxStatus(null);
    }
  };

  const bal0Human = bal0 ? Number(formatUnits(bal0, pool.token0.decimals)) : 0;
  const bal1Human = bal1 ? Number(formatUnits(bal1, pool.token1.decimals)) : 0;

  // 바꾸기와 동일한 pill 패턴. 잔액 기반 비율을 bigint 산술로 정확히 계산
  // (Number로 계산하면 18 decimals 토큰에서 부동소수점 오차 누적). 기존
  // editToken* 경유해서 들어가므로 driver도 자동 세팅된다.
  const percentOf0 = (pct: number) => {
    if (!bal0) return;
    const part = (bal0 * BigInt(pct)) / 100n;
    editToken0(formatUnits(part, pool.token0.decimals));
  };
  const percentOf1 = (pct: number) => {
    if (!bal1) return;
    const part = (bal1 * BigInt(pct)) / 100n;
    editToken1(formatUnits(part, pool.token1.decimals));
  };

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-md" onClick={onClose} />

      <div className="relative w-full max-w-md bg-white mx-0 sm:mx-4 rounded-t-toss-lg sm:rounded-toss-lg overflow-hidden max-h-[92vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 shrink-0">
          <div>
            <h3 className="text-[16px] font-bold text-neutral-900">
              {pool.token0.symbol} / {pool.token1.symbol}
            </h3>
            <p className="text-[12px] text-neutral-400 mt-0.5">
              {pool.version.toUpperCase()}{pool.fee ? ` · 수수료 ${(pool.fee / 10000).toFixed(2)}%` : ""}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-neutral-50 text-neutral-400 hover:text-neutral-700 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Mode tabs */}
        <div className="flex mx-5 mb-3 p-1 rounded-toss bg-neutral-50 shrink-0">
          {(["deposit", "withdraw"] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => onSwitchMode(m)}
              className={cn(
                "flex-1 py-2.5 rounded-[12px] text-[13px] font-bold transition-all",
                mode === m ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-400 hover:text-neutral-700"
              )}
            >
              {m === "deposit" ? "맡기기" : "꺼내기"}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-3 space-y-3">

          {mode === "deposit" ? (
            <>
              {/* ── 포지션 타겟 선택 (V3 + 기존 포지션 있을 때만) ──
                  기존 포지션이 있을 땐 "신규 / 기존에 추가" 중 먼저 고르게
                  한다. 신규면 mint(), 기존 추가면 increaseLiquidity() 경로로
                  분기. V2는 LP 토큰이 pair당 하나뿐이라 addLiquidity가 곧바로
                  기존 잔고에 합산되므로 선택기 자체가 불필요.
                  기존 포지션 선택 시 range picker는 숨기고 해당 포지션의
                  tick으로 자동 고정된다. */}
              {hasAnyV3 && (
                <div className="rounded-toss bg-neutral-50 p-3 space-y-2">
                  <p className="text-[12px] font-bold text-neutral-900 px-1">어디에 맡길까요?</p>
                  <div className="space-y-1.5">
                    <button
                      onClick={() => setDepositTargetId(null)}
                      className={cn(
                        "w-full flex items-center gap-3 px-3 py-2.5 rounded-[12px] transition-all text-left",
                        depositTargetId === null
                          ? "bg-white ring-2 ring-toss-500"
                          : "bg-white/60 hover:bg-white",
                      )}
                    >
                      <div className={cn(
                        "w-8 h-8 rounded-full flex items-center justify-center shrink-0",
                        depositTargetId === null ? "bg-toss-50 text-toss-500" : "bg-neutral-100 text-neutral-400",
                      )}>
                        <Plus size={16} strokeWidth={2.5} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-bold text-neutral-900">새 포지션 만들기</p>
                        <p className="text-[11px] text-neutral-400 truncate">
                          수익 구간을 직접 골라 맡겨요
                        </p>
                      </div>
                    </button>
                    {v3Slices.map((slice) => {
                      const isFull =
                        slice.tickLower <= MIN_TICK || slice.tickUpper >= MAX_TICK;
                      const lo = isFull ? null : tickToPrice(slice.tickLower, pool.token0.decimals, pool.token1.decimals);
                      const hi = isFull ? null : tickToPrice(slice.tickUpper, pool.token0.decimals, pool.token1.decimals);
                      const selected = depositTargetId === slice.tokenId;
                      return (
                        <button
                          key={slice.tokenId.toString()}
                          onClick={() => setDepositTargetId(slice.tokenId)}
                          className={cn(
                            "w-full flex items-center gap-3 px-3 py-2.5 rounded-[12px] transition-all text-left",
                            selected
                              ? "bg-white ring-2 ring-toss-500"
                              : "bg-white/60 hover:bg-white",
                          )}
                        >
                          <div className={cn(
                            "w-8 h-8 rounded-full flex items-center justify-center shrink-0",
                            selected ? "bg-toss-50 text-toss-500" : "bg-neutral-100 text-neutral-400",
                          )}>
                            <Layers size={16} strokeWidth={2.5} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[13px] font-bold text-neutral-900">
                              포지션 #{slice.tokenId.toString().slice(-5)}에 추가
                            </p>
                            <p className="text-[11px] text-neutral-400 truncate tabular-nums">
                              {isFull
                                ? "전체 구간"
                                : `${formatPriceCompact(lo!)} – ${formatPriceCompact(hi!)} ${pool.token1.symbol}/${pool.token0.symbol}`}
                            </p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* V3 수익 구간 설정 — 신규 포지션 만들기일 때만 */}
              {pool.version === "v3" && depositTargetId === null && (
                <div className="rounded-toss bg-neutral-50 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-[13px] font-bold text-neutral-900">수익 구간</p>
                    {live && (
                      <p className="text-[11px] text-neutral-400 tabular-nums">
                        현재가 <span className="font-mono text-neutral-700">
                          1 {live.token0.symbol} = {formatPriceCompact(live.price1Per0)} {live.token1.symbol}
                        </span>
                      </p>
                    )}
                  </div>

                  {/* Preset buttons */}
                  <div className="grid grid-cols-5 gap-1.5">
                    {RANGE_PRESETS.map((p) => (
                      <button
                        key={p.key}
                        onClick={() => p.key === "custom" ? pickCustom() : setRangeKey(p.key)}
                        className={cn(
                          "py-2.5 rounded-[12px] text-[12px] font-bold transition-all flex flex-col items-center gap-0.5",
                          rangeKey === p.key
                            ? "bg-toss-500 text-white"
                            : "bg-white text-neutral-700 hover:bg-neutral-100"
                        )}
                      >
                        <span>{p.label}</span>
                        <span className={cn(
                          "text-[10px] font-medium",
                          rangeKey === p.key ? "text-white/70" : "text-neutral-400"
                        )}>{p.hint}</span>
                      </button>
                    ))}
                  </div>

                  {/* Resolved range readout — editable inputs when 직접 is active */}
                  {live && (
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-[12px] bg-white px-3 py-2.5">
                        <p className="text-[10px] text-neutral-400 mb-0.5">최저 가격</p>
                        {rangeKey === "custom" ? (
                          <input
                            type="number" min="0" step="any"
                            value={customLower}
                            onChange={(e) => setCustomLower(e.target.value)}
                            placeholder="0"
                            className="w-full bg-transparent text-[13px] font-bold text-neutral-900 placeholder:text-neutral-300 outline-none tabular-nums font-mono"
                          />
                        ) : (
                          <p className="text-[13px] font-bold text-neutral-900 tabular-nums font-mono truncate">
                            {rangeKey === "full" ? "0" : range ? formatPriceCompact(range.lowerPrice) : "—"}
                          </p>
                        )}
                        <p className="text-[10px] text-neutral-400 mt-0.5">
                          {live.token1.symbol} / {live.token0.symbol}
                        </p>
                      </div>
                      <div className="rounded-[12px] bg-white px-3 py-2.5">
                        <p className="text-[10px] text-neutral-400 mb-0.5">최고 가격</p>
                        {rangeKey === "custom" ? (
                          <input
                            type="number" min="0" step="any"
                            value={customUpper}
                            onChange={(e) => setCustomUpper(e.target.value)}
                            placeholder="0"
                            className="w-full bg-transparent text-[13px] font-bold text-neutral-900 placeholder:text-neutral-300 outline-none tabular-nums font-mono"
                          />
                        ) : (
                          <p className="text-[13px] font-bold text-neutral-900 tabular-nums font-mono truncate">
                            {rangeKey === "full" ? "∞" : range ? formatPriceCompact(range.upperPrice) : "—"}
                          </p>
                        )}
                        <p className="text-[10px] text-neutral-400 mt-0.5">
                          {live.token1.symbol} / {live.token0.symbol}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Validation hint for 직접 mode */}
                  {rangeKey === "custom" && !range && (customLower || customUpper) && (
                    <p className="text-[11px] text-red-500 leading-relaxed">
                      최고 가격이 최저 가격보다 커야 해요
                    </p>
                  )}

                  <p className="text-[11px] text-neutral-500 leading-relaxed">
                    선택한 구간 안에서 가격이 움직일 때만 수수료 수익이 쌓여요. 좁을수록 수익률이 높지만 벗어날 확률도 커져요.
                  </p>
                </div>
              )}

              {/* 기존 포지션 추가 — 구간 readonly 표시
                  Range picker는 숨겼지만, "어느 구간에 추가되는지"는 명확히
                  보여줘야 사용자가 감을 잡는다. 살짝 다른 톤(연한 파란 테두리)
                  으로 "정보 표시"임을 구분. */}
              {pool.version === "v3" && depositTargetSlice && live && (
                <div className="rounded-toss bg-toss-50 px-4 py-3 flex items-center justify-between">
                  <div className="min-w-0">
                    <p className="text-[11px] font-bold text-toss-600 mb-0.5">추가할 구간</p>
                    {depositTargetSlice.tickLower <= MIN_TICK || depositTargetSlice.tickUpper >= MAX_TICK ? (
                      <p className="text-[13px] font-bold text-neutral-900">전체 구간</p>
                    ) : (
                      <p className="text-[13px] font-bold text-neutral-900 tabular-nums truncate">
                        {formatPriceCompact(tickToPrice(depositTargetSlice.tickLower, pool.token0.decimals, pool.token1.decimals))}
                        {" – "}
                        {formatPriceCompact(tickToPrice(depositTargetSlice.tickUpper, pool.token0.decimals, pool.token1.decimals))}
                        <span className="text-[10px] font-bold text-neutral-400 ml-1">
                          {pool.token1.symbol}/{pool.token0.symbol}
                        </span>
                      </p>
                    )}
                  </div>
                  <p className="text-[10px] text-neutral-400 tabular-nums shrink-0 ml-3">
                    현재가 <span className="font-mono text-neutral-700">
                      {formatPriceCompact(live.price1Per0)}
                    </span>
                  </p>
                </div>
              )}

              {/* Token 0 input — either side can drive; the other is auto-derived */}
              <LiquidityInput
                token={pool.token0}
                amount={amount0}
                balanceHuman={bal0Human}
                showBalance={isConnected}
                wkrcValue={wkrc0}
                exceedsBalance={a0Num > bal0Human && isConnected}
                onChange={editToken0}
                onPercent={percentOf0}
              />

              <div className="flex justify-center text-neutral-300 text-sm font-medium">+</div>

              {/* Token 1 input — editable too (driver switches to side 1) */}
              <LiquidityInput
                token={pool.token1}
                amount={amount1}
                balanceHuman={bal1Human}
                showBalance={isConnected}
                wkrcValue={wkrc1}
                exceedsBalance={a1Num > bal1Human && isConnected}
                onChange={editToken1}
                onPercent={percentOf1}
              />

              {/* 양쪽이 같이 움직이는 이유 — 한쪽만 고쳐도 반대쪽이 현재가
                  비율로 자동 맞춰지는 게 V2/V3 LP의 기본 동작. 안 알려주면
                  사용자가 "왜 내가 안 누른 쪽이 바뀌지?" 혼란스러워함.
                  잔액 초과 시엔 한쪽 줄이면 다른 쪽도 따라 줄어든다는 점을
                  같은 문구에서 알려줌. */}
              {a0Num > 0 && a1Num > 0 && (
                <p className="text-[11px] text-neutral-400 leading-relaxed px-1">
                  {pool.version === "v2"
                    ? "두 토큰은 풀 잔고 비율로 함께 움직여요. 한 쪽을 바꾸면 다른 쪽이 자동으로 맞춰져요."
                    : depositTargetSlice
                      ? "이 포지션의 가격 구간에 맞춰 두 토큰이 함께 움직여요."
                      : "선택한 구간과 현재가 기준으로 두 토큰이 함께 움직여요."}
                </p>
              )}

              {/* 잔액 부족 → 행동 가능한 힌트. 한쪽이 넘치면 넘친 쪽을
                  줄이라고 가이드. "잔액에 맞추기" 버튼 하나로 초과한 쪽을
                  그 잔액 수준으로 리셋해서 양쪽이 다시 비율 안에 들어오게 함. */}
              {(a0Num > bal0Human || a1Num > bal1Human) && isConnected && (
                <div className="rounded-toss bg-gain-50 px-4 py-3 flex items-center justify-between gap-3">
                  <p className="text-[12px] font-bold text-gain-600 leading-tight">
                    {a0Num > bal0Human && a1Num > bal1Human
                      ? "양쪽 잔액이 부족해요"
                      : `${a0Num > bal0Human ? pool.token0.symbol : pool.token1.symbol} 잔액이 부족해요`}
                  </p>
                  <button
                    onClick={() => {
                      // 초과한 쪽을 "잔액 전부"로 리셋 → useEffect가 반대쪽을
                      // 비율대로 다시 채움. 양쪽 다 초과면 더 타이트한 제약
                      // 쪽(잔액 대비 필요량이 큰 쪽)을 driver로.
                      const over0 = a0Num > bal0Human;
                      const over1 = a1Num > bal1Human;
                      if (over0 && !over1) {
                        if (bal0) editToken0(formatUnits(bal0, pool.token0.decimals));
                      } else if (over1 && !over0) {
                        if (bal1) editToken1(formatUnits(bal1, pool.token1.decimals));
                      } else {
                        // 양쪽 다 초과 — 잔액이 더 모자란 쪽(비율 대비) 기준으로
                        const shortfall0 = bal0Human > 0 ? a0Num / bal0Human : Infinity;
                        const shortfall1 = bal1Human > 0 ? a1Num / bal1Human : Infinity;
                        if (shortfall0 >= shortfall1 && bal0) {
                          editToken0(formatUnits(bal0, pool.token0.decimals));
                        } else if (bal1) {
                          editToken1(formatUnits(bal1, pool.token1.decimals));
                        }
                      }
                    }}
                    className="shrink-0 text-[11px] font-bold text-gain-600 bg-white/70 hover:bg-white px-2 py-1 rounded-md press"
                  >
                    잔액에 맞추기
                  </button>
                </div>
              )}

              {/* Total (WKRC only when rateable) */}
              {totalWKRC !== null && totalWKRC > 0 && (
                <div className="flex items-center justify-between px-4 py-3 rounded-toss bg-toss-50 text-sm">
                  <span className="text-neutral-500">맡길 금액</span>
                  <span className="font-bold text-toss-600 tabular-nums">{formatWKRC(totalWKRC)}</span>
                </div>
              )}
            </>
          ) : !hasPosition ? (
            /* ── 꺼내기 empty state ─────────────────────────────── */
            <EmptyWithdraw
              pairLabel={`${pool.token0.symbol} / ${pool.token1.symbol}`}
              onStartDeposit={() => onSwitchMode("deposit")}
            />
          ) : (
            <>
              {/* ── 포지션별 꺼내기 선택 (V3 + 포지션 2개 이상) ──
                  포지션 1개면 선택할 이유가 없어 숨긴다. 2개부터는 어떤
                  포지션에서 꺼낼지 명시적으로 골라야 한다 — 이전에는 슬라이더
                  1개가 모든 포지션에 동일 % 적용되어 "두 곳에서 각각 47%씩"
                  빠져나가는 혼란이 있었다. */}
              {hasMultipleV3 && (
                <div className="rounded-toss bg-neutral-50 p-3 space-y-2">
                  <p className="text-[12px] font-bold text-neutral-900 px-1">어느 포지션에서 꺼낼까요?</p>
                  <div className="space-y-1.5">
                    {v3Slices.map((slice) => {
                      const isFull =
                        slice.tickLower <= MIN_TICK || slice.tickUpper >= MAX_TICK;
                      const lo = isFull ? null : tickToPrice(slice.tickLower, pool.token0.decimals, pool.token1.decimals);
                      const hi = isFull ? null : tickToPrice(slice.tickUpper, pool.token0.decimals, pool.token1.decimals);
                      const selected = withdrawTokenId === slice.tokenId;
                      return (
                        <button
                          key={slice.tokenId.toString()}
                          onClick={() => setWithdrawTokenId(slice.tokenId)}
                          className={cn(
                            "w-full flex items-center gap-3 px-3 py-2.5 rounded-[12px] transition-all text-left",
                            selected
                              ? "bg-white ring-2 ring-toss-500"
                              : "bg-white/60 hover:bg-white",
                          )}
                        >
                          <div className={cn(
                            "w-8 h-8 rounded-full flex items-center justify-center shrink-0",
                            selected ? "bg-toss-50 text-toss-500" : "bg-neutral-100 text-neutral-400",
                          )}>
                            <Layers size={16} strokeWidth={2.5} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[13px] font-bold text-neutral-900">
                              포지션 #{slice.tokenId.toString().slice(-5)}
                            </p>
                            <p className="text-[11px] text-neutral-400 truncate tabular-nums">
                              {isFull
                                ? "전체 구간"
                                : `${formatPriceCompact(lo!)} – ${formatPriceCompact(hi!)}`}
                              <span className="mx-1">·</span>
                              {formatToken(slice.amount0, pool.token0.symbol, pool.token0.decimals)}
                              {" + "}
                              {formatToken(slice.amount1, pool.token1.symbol, pool.token1.decimals)}
                            </p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Withdraw percent */}
              <div className="p-4 rounded-toss bg-neutral-50">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[12px] text-neutral-500">얼마나 꺼낼까요?</span>
                  <div className="flex items-baseline gap-1">
                    <span className="text-[28px] font-black text-neutral-900 tabular-nums leading-none">{percent}</span>
                    <span className="text-sm font-bold text-neutral-400">%</span>
                  </div>
                </div>
                <input
                  type="range" min={1} max={100} step={1}
                  value={percent}
                  onChange={(e) => setPercent(Number(e.target.value))}
                  className="w-full accent-toss-500"
                />
                {/* 바꾸기/맡기기와 동일한 preset pill 스타일(AmountPresets).
                    여기는 "position의 %"를 고르는 용도라 꽉 찬 md 크기로,
                    현재 슬라이더 값과 정확히 일치하면 active 강조. */}
                <div className="mt-3">
                  <AmountPresets
                    size="md"
                    active={percent}
                    onPercent={(v) => setPercent(v)}
                    onMax={() => setPercent(100)}
                  />
                </div>
              </div>

              {/* Returns — 선택된 포지션(혹은 V2는 단일 LP) 기준으로 계산.
                  V3 다중 포지션에서 withdrawTokenId가 지정되면 그 1개만 합산. */}
              {(() => {
                const allSlices = pool.myPositionSlices ?? [];
                const slices =
                  pool.version === "v3" && withdrawTokenId !== null
                    ? allSlices.filter((s) => s.tokenId === withdrawTokenId)
                    : allSlices;
                const sumA0 = slices.reduce((s, p) => s + p.amount0, 0);
                const sumA1 = slices.reduce((s, p) => s + p.amount1, 0);
                const sumO0 = slices.reduce((s, p) => s + p.owed0, 0);
                const sumO1 = slices.reduce((s, p) => s + p.owed1, 0);
                const cut = percent / 100;
                const out0 = sumA0 * cut + sumO0;
                const out1 = sumA1 * cut + sumO1;
                return (
                  <div className="px-4 py-3 rounded-toss bg-neutral-50 space-y-2">
                    <p className="text-[11px] text-neutral-400 mb-2">돌려받는 금액</p>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-neutral-500">{pool.token0.symbol}</span>
                      <span className="font-bold text-neutral-900 tabular-nums">
                        {formatToken(out0, pool.token0.symbol, pool.token0.decimals)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-neutral-500">{pool.token1.symbol}</span>
                      <span className="font-bold text-neutral-900 tabular-nums">
                        {formatToken(out1, pool.token1.symbol, pool.token1.decimals)}
                      </span>
                    </div>
                    {(sumO0 > 0 || sumO1 > 0) && (
                      <p className="text-[11px] text-gain-500 pt-0.5">
                        수수료 수익 포함
                      </p>
                    )}
                    {slices.length > 1 && (
                      <p className="text-[11px] text-neutral-400 pt-0.5">
                        포지션 {slices.length}개 합산
                      </p>
                    )}
                  </div>
                );
              })()}

              {/* ── 포지션 상세 ──
                  V3 다중 포지션: 선택된 포지션 1개만 상세로 노출 (picker에서
                  이미 라벨/구간이 요약되어 있으므로 여기서는 수수료·잔액 등
                  본격 수치를 보여준다).
                  V3 단일 / V2: 기존처럼 전체 슬라이스를 접고-펼치는 방식. */}
              {(() => {
                const allSlices = pool.myPositionSlices ?? [];
                if (allSlices.length === 0) return null;

                // 다중 V3: 선택된 포지션 1개만 보여준다. 접기 없이 바로 펼친다.
                if (pool.version === "v3" && withdrawTokenId !== null && allSlices.length > 1) {
                  const idx = allSlices.findIndex((s) => s.tokenId === withdrawTokenId);
                  const slice = idx >= 0 ? allSlices[idx] : null;
                  if (!slice) return null;
                  return (
                    <div>
                      <p className="px-1 pb-1.5 text-[12px] font-bold text-neutral-500">선택한 포지션</p>
                      <SliceDetail slice={slice} index={idx} pool={pool} />
                    </div>
                  );
                }

                return (
                  <div>
                    <button
                      onClick={() => setShowSliceDetails((v) => !v)}
                      className="w-full flex items-center justify-between px-1 py-1.5 text-[12px] text-neutral-500 hover:text-neutral-900 press"
                    >
                      <span className="font-bold">
                        {pool.version === "v3" ? "포지션별 상세" : "자세히 보기"}
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="text-[11px] text-neutral-400 tabular-nums">
                          {allSlices.length}개
                        </span>
                        <ChevronDown
                          size={14}
                          className={cn(
                            "transition-transform",
                            showSliceDetails && "rotate-180",
                          )}
                        />
                      </span>
                    </button>

                    {showSliceDetails && (
                      <div className="mt-2 space-y-2">
                        {allSlices.map((slice, i) => (
                          <SliceDetail
                            key={slice.tokenId.toString()}
                            slice={slice}
                            index={i}
                            pool={pool}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}

              <p className="text-[11px] text-neutral-400 px-1 leading-relaxed">
                꺼내기 버튼을 누르면 지갑에서 서명하고 바로 돌려받아요.
                {pool.version === "v3"
                  ? hasMultipleV3
                    ? " 고른 포지션에서만 꺼내요 — 다른 포지션은 그대로 유지돼요."
                    : " 원금과 쌓인 수수료가 같이 돌아와요."
                  : " LP 토큰 사용 승인이 먼저 필요할 수 있어요."}
              </p>
            </>
          )}

        </div>

        {/* CTA — pinned at bottom, hidden when withdraw empty state is showing */}
        {!(mode === "withdraw" && !hasPosition) && (
          <div className="px-5 pb-5 pt-2 shrink-0">
            <PrimaryButton
              onClick={handleConfirm}
              loading={loading}
            >
              {loading
                ? (txStatus?.label ?? "처리 중...")
                : !isConnected
                ? "지갑 연결"
                : mode === "deposit"
                ? (depositTargetId !== null ? "추가 맡기기" : "맡기기")
                : "꺼내기"}
            </PrimaryButton>
          </div>
        )}

      </div>
    </div>,
    document.body,
  );
}

// ── Withdraw empty state ─────────────────────────────────────────────────────
// When the user opens withdraw mode for a pool they haven't deposited to.
// Friendly empty state with a path forward (→ switch to 맡기기).

function EmptyWithdraw({
  pairLabel,
  onStartDeposit,
}: {
  pairLabel: string;
  onStartDeposit: () => void;
}) {
  return (
    <div className="py-4">
      <div className="flex flex-col items-center text-center py-6 px-4">
        <div
          className="w-14 h-14 rounded-full flex items-center justify-center mb-3"
          style={{ backgroundColor: "#E8F3FF" }}
        >
          <PiggyBank size={24} style={{ color: "#3182F6" }} />
        </div>
        <p className="text-[15px] font-bold text-neutral-900">
          아직 맡긴 금액이 없어요
        </p>
        <p className="text-[12px] text-neutral-400 mt-1 leading-relaxed">
          {pairLabel} 상품에 먼저 맡기면
          <br />여기서 꺼낼 수 있어요
        </p>
      </div>
      <PrimaryButton onClick={onStartDeposit}>
        맡기러 가기
      </PrimaryButton>
    </div>
  );
}

// ── SliceDetail ──────────────────────────────────────────────────────────────
// One row per underlying position: price range, per-side amount, owed fees.
// V3 shows the real tick→price range. V2 positions use ±887272 sentinels
// (full-range) and render as "전체 구간" since a V2 pair has no bounded range.

function SliceDetail({
  slice,
  index,
  pool,
}: {
  slice: NonNullable<Pool["myPositionSlices"]>[number];
  index: number;
  pool: Pool;
}) {
  const isFullRange =
    pool.version === "v2" ||
    slice.tickLower <= MIN_TICK ||
    slice.tickUpper >= MAX_TICK;

  const lowerPrice = isFullRange
    ? null
    : tickToPrice(slice.tickLower, pool.token0.decimals, pool.token1.decimals);
  const upperPrice = isFullRange
    ? null
    : tickToPrice(slice.tickUpper, pool.token0.decimals, pool.token1.decimals);

  const label =
    pool.version === "v3"
      ? `포지션 #${slice.tokenId.toString().slice(-5)}`
      : "LP 토큰";

  return (
    <div className="rounded-toss bg-neutral-50 overflow-hidden">
      {/* Header row — 번호, 라벨, 배지 */}
      <div className="px-4 pt-3 pb-2 flex items-center justify-between">
        <span className="text-[12px] font-bold text-neutral-900">
          {index + 1}. {label}
        </span>
        <span className={cn(
          "text-[10px] font-bold px-1.5 py-0.5 rounded",
          isFullRange
            ? "text-neutral-500 bg-white"
            : "text-toss-500 bg-toss-50",
        )}>
          {isFullRange ? "전체 구간" : "지정 구간"}
        </span>
      </div>

      {/* ── Range hero — V3의 핵심 정보 ──
          가격 구간을 한 줄에 꽉 채워서 가장 눈에 띄게 노출. V2/full-range는
          "전체 구간"으로 축약. */}
      {!isFullRange && (
        <div className="mx-4 mb-2 rounded bg-white px-3 py-2.5">
          <p className="text-[10px] font-bold text-neutral-400 mb-1">가격 구간</p>
          <div className="flex items-baseline gap-1.5 tabular-nums">
            <span className="text-[14px] font-bold text-neutral-900">
              {formatPriceCompact(lowerPrice!)}
            </span>
            <span className="text-[12px] text-neutral-400">–</span>
            <span className="text-[14px] font-bold text-neutral-900">
              {formatPriceCompact(upperPrice!)}
            </span>
            <span className="text-[10px] font-bold text-neutral-400 ml-1">
              {pool.token1.symbol}/{pool.token0.symbol}
            </span>
          </div>
        </div>
      )}
      {isFullRange && pool.version === "v2" && (
        <div className="mx-4 mb-2 rounded bg-white px-3 py-2.5">
          <p className="text-[11px] text-neutral-500">
            V2는 가격 구간이 없고, 전체 가격대에 자동으로 예치돼요
          </p>
        </div>
      )}

      {/* 토큰별 보유량 */}
      <div className="px-4 py-2 space-y-1.5 border-t border-white">
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-neutral-500">{pool.token0.symbol}</span>
          <span className="font-bold text-neutral-900 tabular-nums">
            {formatToken(slice.amount0, pool.token0.symbol, pool.token0.decimals)}
          </span>
        </div>
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-neutral-500">{pool.token1.symbol}</span>
          <span className="font-bold text-neutral-900 tabular-nums">
            {formatToken(slice.amount1, pool.token1.symbol, pool.token1.decimals)}
          </span>
        </div>
      </div>

      {(slice.owed0 > 0 || slice.owed1 > 0) && (
        <div className="px-4 py-2 border-t border-white space-y-1">
          <p className="text-[11px] font-bold text-gain-500">수수료 수익</p>
          {slice.owed0 > 0 && (
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-neutral-500">{pool.token0.symbol}</span>
              <span className="font-bold text-gain-500 tabular-nums">
                +{formatToken(slice.owed0, pool.token0.symbol, pool.token0.decimals)}
              </span>
            </div>
          )}
          {slice.owed1 > 0 && (
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-neutral-500">{pool.token1.symbol}</span>
              <span className="font-bold text-gain-500 tabular-nums">
                +{formatToken(slice.owed1, pool.token1.symbol, pool.token1.decimals)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* padding bottom */}
      <div className="h-2" />
    </div>
  );
}

// Trim a derived number to a clean human string without float noise.
// `toFixed(decimals)` preserves enough precision for the contract call; then
// we strip trailing zeros so "0.8234560000" → "0.823456" and "1.000000" → "1".
function trimDerived(n: number, decimals: number): string {
  const cap = Math.min(Math.max(decimals, 0), 8);
  const s = n.toFixed(cap);
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "");
}

// ── LiquidityInput ───────────────────────────────────────────────────────────

interface LiquidityInputProps {
  token: Pool["token0"];
  amount: string;
  balanceHuman?: number;
  showBalance?: boolean;
  wkrcValue: number | null;
  onChange: (v: string) => void;
  readonly?: boolean;
  /** 잔액 기반 preset pill — 연결된 경우에만 렌더. readonly 입력에선 의미 없음. */
  onPercent?: (pct: number) => void;
  /** 입력한 양이 이 토큰의 잔액을 초과하는지. true면 빨간 ring으로 시각화. */
  exceedsBalance?: boolean;
}

function LiquidityInput({
  token, amount, balanceHuman, showBalance, wkrcValue,
  onChange, readonly, onPercent, exceedsBalance,
}: LiquidityInputProps) {
  const displayAmount = amount
    ? (readonly ? formatTokenAmount(Number(amount), token.decimals) : amount)
    : "";

  return (
    <div className={cn(
      "rounded-toss bg-neutral-50 p-4 transition-colors",
      // 잔액 초과 시 빨간 ring — SendModal의 금액 인풋과 같은 패턴으로 통일.
      exceedsBalance && "ring-2 ring-gain-500 bg-gain-50/60",
    )}>
      {showBalance && (
        <div className="flex items-center justify-between mb-1.5">
          {/* 25 / 50 / 75 / 최대 pill — 바꾸기 화면과 같은 컴포넌트. 양쪽
              토큰 인풋 모두에서 동작하므로 한 쪽만 편집해도 다른 쪽이
              비율대로 자동 채워진다. readonly(driver가 반대쪽) 상태에선
              해당 쪽 pill을 그려도 혼란만 주기 때문에 onPercent 없으면 숨김. */}
          {!readonly && onPercent && (balanceHuman ?? 0) > 0 ? (
            <AmountPresets onPercent={onPercent} size="sm" />
          ) : (
            <span />
          )}
          <span className={cn(
            "text-[11px] tabular-nums",
            exceedsBalance ? "text-gain-600 font-bold" : "text-neutral-400",
          )}>
            잔액 {formatToken(balanceHuman ?? 0, token.symbol, token.decimals)}
          </span>
        </div>
      )}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 shrink-0 pl-2.5 pr-3 py-1.5 rounded-full bg-white">
          <span className="w-5 h-5 rounded-full bg-neutral-50 flex items-center justify-center text-[13px]">
            {token.logoUrl ?? "🪙"}
          </span>
          <span className="text-[13px] font-bold text-neutral-900">{token.symbol}</span>
        </div>
        <div className="flex-1 text-right min-w-0">
          {readonly ? (
            <p className={cn(
              "text-[26px] font-black tabular-nums truncate tracking-tight leading-none",
              amount
                ? exceedsBalance ? "text-gain-600" : "text-neutral-900"
                : "text-neutral-200"
            )}>
              {displayAmount || "0"}
            </p>
          ) : (
            <input
              type="number" min="0" placeholder="0"
              value={amount}
              onChange={(e) => onChange(e.target.value)}
              className={cn(
                "w-full bg-transparent text-right text-[26px] font-black placeholder:text-neutral-200 outline-none tabular-nums tracking-tight leading-none",
                exceedsBalance ? "text-gain-600" : "text-neutral-900",
              )}
            />
          )}
          {wkrcValue !== null && wkrcValue > 0 && (
            <p className="text-[11px] text-neutral-400 mt-1 tabular-nums">
              ≈ {formatWKRC(wkrcValue)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
