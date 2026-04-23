// Uniswap V3 price ↔ tick helpers, plus user-friendly preset ranges.
//
// Pool price relationship: price(token1 per 1 token0) = 1.0001 ^ tick,
// scaled by 10^(decimals0 - decimals1) to get a *human* price.

const BASE = 1.0001;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/** price (human token1/token0) → raw tick */
export function priceToTick(
  price: number,
  decimals0: number,
  decimals1: number,
): number {
  if (price <= 0) return MIN_TICK;
  const rawPrice = price / Math.pow(10, decimals0 - decimals1);
  return Math.log(rawPrice) / Math.log(BASE);
}

/** raw tick → price (human token1/token0) */
export function tickToPrice(
  tick: number,
  decimals0: number,
  decimals1: number,
): number {
  return Math.pow(BASE, tick) * Math.pow(10, decimals0 - decimals1);
}

/** Snap a tick to the nearest valid multiple of tickSpacing */
export function alignTick(tick: number, tickSpacing: number, dir: "down" | "up" = "down"): number {
  if (!isFinite(tick)) return dir === "down" ? MIN_TICK : MAX_TICK;
  const n = tick / tickSpacing;
  const snapped = dir === "down" ? Math.floor(n) : Math.ceil(n);
  const out = snapped * tickSpacing;
  return Math.max(MIN_TICK, Math.min(MAX_TICK, out));
}

// ── Preset ranges ────────────────────────────────────────────────────────────
// All offsets are percentages away from the current price.
// "full" means full-range (MIN_TICK/MAX_TICK aligned to tickSpacing).
export type RangePresetKey = "narrow" | "standard" | "wide" | "full" | "custom";

export interface RangePreset {
  key: RangePresetKey;
  label: string;    // Korean, Web2-friendly
  hint: string;     // short explanation
  offsetPct?: number; // ±percent from current price; undefined for "full"/"custom"
}

export const RANGE_PRESETS: RangePreset[] = [
  { key: "narrow",   label: "좁게",   hint: "±2%",   offsetPct: 2 },
  { key: "standard", label: "표준",   hint: "±10%",  offsetPct: 10 },
  { key: "wide",     label: "넓게",   hint: "±50%",  offsetPct: 50 },
  { key: "full",     label: "전체",   hint: "제한 없음" },
  { key: "custom",   label: "직접",   hint: "가격 지정" },
];

/**
 * Convert a user-entered human price pair (token1 per 1 token0) into a
 * tick-spacing-aligned range. Used for the "직접" preset where the user
 * types lower/upper prices into the form.
 */
export function resolveCustomRange(
  lowerPrice: number,
  upperPrice: number,
  tickSpacing: number,
  decimals0: number,
  decimals1: number,
): { lowerTick: number; upperTick: number; lowerPrice: number; upperPrice: number } | null {
  if (!isFinite(lowerPrice) || !isFinite(upperPrice)) return null;
  if (lowerPrice <= 0 || upperPrice <= 0) return null;
  if (!(upperPrice > lowerPrice)) return null;
  const loTick = alignTick(priceToTick(lowerPrice, decimals0, decimals1), tickSpacing, "down");
  const hiTick = alignTick(priceToTick(upperPrice, decimals0, decimals1), tickSpacing, "up");
  if (!(hiTick > loTick)) return null;
  return {
    lowerTick: loTick,
    upperTick: hiTick,
    lowerPrice: tickToPrice(loTick, decimals0, decimals1),
    upperPrice: tickToPrice(hiTick, decimals0, decimals1),
  };
}

/**
 * Given a live pool state, return { lowerTick, upperTick, lowerPrice, upperPrice }
 * for a given preset.
 */
export function resolvePreset(
  preset: RangePreset,
  currentPrice: number,    // price1Per0 — human units
  tickSpacing: number,
  decimals0: number,
  decimals1: number,
): { lowerTick: number; upperTick: number; lowerPrice: number; upperPrice: number } {
  if (preset.key === "full") {
    const lo = alignTick(MIN_TICK, tickSpacing, "up");
    const hi = alignTick(MAX_TICK, tickSpacing, "down");
    return {
      lowerTick: lo,
      upperTick: hi,
      lowerPrice: tickToPrice(lo, decimals0, decimals1),
      upperPrice: tickToPrice(hi, decimals0, decimals1),
    };
  }
  const pct = (preset.offsetPct ?? 10) / 100;
  const loPrice = currentPrice * (1 - pct);
  const hiPrice = currentPrice * (1 + pct);
  const loTick = alignTick(priceToTick(loPrice, decimals0, decimals1), tickSpacing, "down");
  const hiTick = alignTick(priceToTick(hiPrice, decimals0, decimals1), tickSpacing, "up");
  return {
    lowerTick: loTick,
    upperTick: hiTick,
    lowerPrice: tickToPrice(loTick, decimals0, decimals1),
    upperPrice: tickToPrice(hiTick, decimals0, decimals1),
  };
}

// ── V3 deposit-amount math ───────────────────────────────────────────────────
// Uniswap V3 positions don't deposit in spot-price ratio — they deposit in a
// ratio determined by sqrtPriceX96 and the tick boundaries. For an in-range
// position:
//   L       = amount0_raw × √p × √pU / (√pU − √p)
//   amount1 = L × (√p − √pL)   [raw]
// Using spot price (price1Per0) instead causes the position manager to revert
// with "Price slippage check" because the actual consumed amount on the
// limiting side falls below amount{0,1}Min.
//
// Boundary behavior:
//   - current price ≤ lower bound → only token0 needed; amount1 = 0
//   - current price ≥ upper bound → only token1 needed; caller should flip
//     into an amount1-first flow. We return NaN as a sentinel.
//
// Precision note: we convert sqrtPriceX96 (uint160 bigint) to Number, which
// loses ~15+ digits for large values. The relative error is ~10⁻¹⁴ in the
// amount ratio, well inside our 0.5% slippage buffer. For full-range positions
// the formula reduces to roughly spot × amount0 (within float precision).

const Q96_POW = Math.pow(2, 96);

/**
 * Given amount0 in human units, compute the exact amount1 (human units)
 * that Uniswap V3 NonfungiblePositionManager.mint will consume for the
 * specified range at the current pool price.
 *
 * Returns:
 *   - positive number — normal in-range case; use as amount1Desired
 *   - 0               — current price is at or below the lower bound;
 *                       only token0 is needed
 *   - NaN             — current price is at or above the upper bound;
 *                       caller must drive the input from amount1 instead
 */
export function computeV3Amount1(
  amount0Human: number,
  sqrtPriceX96: bigint,
  lowerTick: number,
  upperTick: number,
  decimals0: number,
  decimals1: number,
): number {
  if (amount0Human <= 0 || !Number.isFinite(amount0Human)) return 0;
  if (!(upperTick > lowerTick)) return 0;

  const sqrtP  = Number(sqrtPriceX96) / Q96_POW;
  const sqrtPL = Math.pow(BASE, lowerTick / 2);
  const sqrtPU = Math.pow(BASE, upperTick / 2);

  if (!Number.isFinite(sqrtP) || sqrtP <= 0) return 0;
  if (sqrtP <= sqrtPL) return 0;        // below range → no token1 needed
  if (sqrtP >= sqrtPU) return NaN;      // above range → token0 not the right driver
  if (!(sqrtPU > sqrtP) || !(sqrtP > sqrtPL)) return 0;

  const amount0Raw = amount0Human * Math.pow(10, decimals0);
  // L = Δx × √p × √pU / (√pU − √p)
  const L = (amount0Raw * sqrtP * sqrtPU) / (sqrtPU - sqrtP);
  if (!Number.isFinite(L) || L <= 0) return 0;
  // Δy = L × (√p − √pL)
  const amount1Raw = L * (sqrtP - sqrtPL);
  if (!Number.isFinite(amount1Raw) || amount1Raw < 0) return 0;
  return amount1Raw / Math.pow(10, decimals1);
}

/**
 * Inverse of computeV3Amount1 — given amount1, derive amount0 via:
 *   L = amount1_raw / (√p − √pL)
 *   amount0 = L × (√pU − √p) / (√p × √pU)
 *
 * Returns:
 *   - positive number — normal in-range case
 *   - 0               — current ≥ upper bound; only token1 needed
 *   - NaN             — current ≤ lower bound; token1 can't drive (caller
 *                       should switch to token0-first flow)
 */
export function computeV3Amount0(
  amount1Human: number,
  sqrtPriceX96: bigint,
  lowerTick: number,
  upperTick: number,
  decimals0: number,
  decimals1: number,
): number {
  if (amount1Human <= 0 || !Number.isFinite(amount1Human)) return 0;
  if (!(upperTick > lowerTick)) return 0;

  const sqrtP  = Number(sqrtPriceX96) / Q96_POW;
  const sqrtPL = Math.pow(BASE, lowerTick / 2);
  const sqrtPU = Math.pow(BASE, upperTick / 2);

  if (!Number.isFinite(sqrtP) || sqrtP <= 0) return 0;
  if (sqrtP >= sqrtPU) return 0;        // above range → no token0 needed
  if (sqrtP <= sqrtPL) return NaN;      // below range → token1 not the right driver
  if (!(sqrtPU > sqrtP) || !(sqrtP > sqrtPL)) return 0;

  const amount1Raw = amount1Human * Math.pow(10, decimals1);
  // L = Δy / (√p − √pL)
  const L = amount1Raw / (sqrtP - sqrtPL);
  if (!Number.isFinite(L) || L <= 0) return 0;
  // Δx = L × (√pU − √p) / (√p × √pU)
  const amount0Raw = (L * (sqrtPU - sqrtP)) / (sqrtP * sqrtPU);
  if (!Number.isFinite(amount0Raw) || amount0Raw < 0) return 0;
  return amount0Raw / Math.pow(10, decimals0);
}

/**
 * Given a position's on-chain state, compute the human amounts of token0 and
 * token1 currently locked. This matches Uniswap V3 NonfungiblePositionManager
 * semantics when `decreaseLiquidity` is called with 100% of the position.
 *
 *   current tick < tickLower:  only token0 locked
 *   current tick ≥ tickUpper:  only token1 locked
 *   in range:                  both sides locked per √p ratio
 *
 * Precision note: same trade-off as computeV3Amount{0,1} — Number(bigint) loses
 * ~15 digits but the relative error is well below display tolerance.
 */
export function positionAmounts(
  liquidity: bigint,
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  decimals0: number,
  decimals1: number,
): { amount0: number; amount1: number } {
  if (liquidity === 0n) return { amount0: 0, amount1: 0 };
  const L = Number(liquidity);
  const sqrtP  = Number(sqrtPriceX96) / Q96_POW;
  const sqrtPL = Math.pow(BASE, tickLower / 2);
  const sqrtPU = Math.pow(BASE, tickUpper / 2);
  if (!(sqrtPU > sqrtPL) || !Number.isFinite(L)) return { amount0: 0, amount1: 0 };

  let amount0Raw = 0;
  let amount1Raw = 0;
  if (sqrtP <= sqrtPL) {
    amount0Raw = (L * (sqrtPU - sqrtPL)) / (sqrtPL * sqrtPU);
  } else if (sqrtP >= sqrtPU) {
    amount1Raw = L * (sqrtPU - sqrtPL);
  } else {
    amount0Raw = (L * (sqrtPU - sqrtP)) / (sqrtP * sqrtPU);
    amount1Raw = L * (sqrtP - sqrtPL);
  }

  const a0 = Number.isFinite(amount0Raw) && amount0Raw > 0
    ? amount0Raw / Math.pow(10, decimals0)
    : 0;
  const a1 = Number.isFinite(amount1Raw) && amount1Raw > 0
    ? amount1Raw / Math.pow(10, decimals1)
    : 0;
  return { amount0: a0, amount1: a1 };
}

/** Format a price with adaptive precision: big numbers → 2 digits, tiny → 6 */
export function formatPriceCompact(p: number): string {
  if (!isFinite(p) || p === 0) return "0";
  if (p >= 1000) return Math.round(p).toLocaleString("ko-KR");
  if (p >= 1)    return p.toLocaleString("ko-KR", { maximumFractionDigits: 4 });
  if (p >= 0.01) return p.toLocaleString("ko-KR", { maximumFractionDigits: 6 });
  return p.toPrecision(3);
}
