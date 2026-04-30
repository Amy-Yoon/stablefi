import type { PoolState } from "@/hooks/usePool";
import type { Token } from "@/lib/chain";

// ── Route model ──────────────────────────────────────────────────────────────
// Represents a single path through the pool graph. The `kind` field lets the
// SwapCard dispatch to the right router function (exactInputSingle vs
// exactInput vs swapExactTokensForTokens).

export type RouteKind = "v3-single" | "v3-multi" | "v2-single" | "v2-multi";

export type RouteVersion = "v2" | "v3";

export interface RouteHop {
  pool: PoolState;
  tokenIn: Token;
  tokenOut: Token;
  /** V3 fee in pips (e.g. 3000 = 0.3%). For V2 this equals pool.fee = 3000 by protocol. */
  fee: number;
}

export interface Route {
  kind: RouteKind;
  /** v2 or v3 — shorthand for dispatch sites that only care which router to hit. */
  version: RouteVersion;
  hops: RouteHop[];
  tokenIn: Token;
  tokenOut: Token;
  /** Composed spot rate: 1 tokenIn → rate tokenOut. Pre-impact, pre-fee. For "1 X = Y" display. */
  rate: number;
  /** Expected output in tokenOut human units at `amountIn` — post-fee, post-impact for V2; post-fee only for V3 (within-tick impact not modeled). */
  estimatedOut: number;
  /** Human-units input used to compute `estimatedOut`. */
  amountIn: number;
  /** Cumulative swap fee fraction across all hops (e.g. 0.006 for 0.3% × 2). */
  feeFraction: number;
  /** Human-readable path for UX: [TokenA, WKRC, TokenB]. */
  path: Token[];
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// ── Hop simulation ───────────────────────────────────────────────────────────
// Converts a human-units amountIn through one pool to its human-units amountOut.
//
// V2: Uniswap x·y=k with fee (0.3% baked in).
//     amountInWithFee = amountIn × (1 - fee/1e6)     (pool.fee is in pips)
//     amountOut = amountInWithFee × reserveOut / (reserveIn + amountInWithFee)
//   EXACT match to V2Router.getAmountsOut. Captures price impact fully.
//
// V3: Within-tick sqrtPrice math using slot0 + current-tick liquidity.
//     Whitepaper formulas (all in raw token units):
//       Δy = L × (√P_new - √P_old)                         [token1 out]
//       Δx = L × (1/√P_new - 1/√P_old)                     [token0 out]
//     For zeroForOne (token0 in): √P decreases, √P_new = L·√P / (L + Δx·√P)
//     For oneForZero (token1 in): √P increases, √P_new = √P + Δy/L
//   This is EXACT within the current tick range. If the swap is large enough
//   to push sqrtPrice across the next initialized tick, the result becomes an
//   APPROXIMATION (we assume L stays constant; reality may have more/less
//   liquidity in neighboring ranges). For the 3-token registry with reasonable
//   liquidity near current price this approximation holds well.
//
//   Falls back to spot × (1 - fee) if sqrtPriceX96 / liquidity are missing
//   (e.g. fetch error, pool fully drained).
function simulateHop(
  pool: PoolState,
  tokenInAddr: `0x${string}`,
  amountIn: number,
): number {
  if (amountIn <= 0 || !Number.isFinite(amountIn)) return 0;
  const fromIs0 = eq(pool.token0.address, tokenInAddr);
  const feeFrac = pool.fee / 1_000_000;

  if (pool.version === "v2") {
    if (pool.reserve0 === undefined || pool.reserve1 === undefined) return 0;
    const r0 = Number(pool.reserve0) / 10 ** pool.token0.decimals;
    const r1 = Number(pool.reserve1) / 10 ** pool.token1.decimals;
    const reserveIn  = fromIs0 ? r0 : r1;
    const reserveOut = fromIs0 ? r1 : r0;
    if (reserveIn <= 0 || reserveOut <= 0) return 0;
    const amountInWithFee = amountIn * (1 - feeFrac);
    return (amountInWithFee * reserveOut) / (reserveIn + amountInWithFee);
  }

  // ── V3 within-tick sqrtPrice simulation ────────────────────────────────────
  const spot = fromIs0 ? pool.price1Per0 : pool.price0Per1;
  const hasTickData =
    pool.sqrtPriceX96 !== undefined &&
    pool.liquidity !== undefined &&
    pool.liquidity > 0n;

  if (!hasTickData) {
    // Pool data incomplete — fall back to spot×(1−fee). Still better than nothing.
    if (!Number.isFinite(spot) || spot <= 0) return 0;
    return amountIn * spot * (1 - feeFrac);
  }

  const Q96  = 2 ** 96;
  const sqrtP = Number(pool.sqrtPriceX96) / Q96;
  const L    = Number(pool.liquidity!);
  if (!Number.isFinite(sqrtP) || sqrtP <= 0 || !Number.isFinite(L) || L <= 0) {
    if (!Number.isFinite(spot) || spot <= 0) return 0;
    return amountIn * spot * (1 - feeFrac);
  }

  const d0 = pool.token0.decimals;
  const d1 = pool.token1.decimals;

  if (fromIs0) {
    // zeroForOne: token0 in, token1 out, price DECREASES
    const amountInRaw       = amountIn * 10 ** d0;
    const amountInAfterFee  = amountInRaw * (1 - feeFrac);
    // √P_new = √P · L / (L + Δx · √P)
    const denom = L + amountInAfterFee * sqrtP;
    if (denom <= 0) return 0;
    const sqrtPnew = (sqrtP * L) / denom;
    if (!Number.isFinite(sqrtPnew) || sqrtPnew <= 0 || sqrtPnew >= sqrtP) return 0;
    // Δy = L · (√P − √P_new)  [raw token1 out]
    const amountOutRaw = L * (sqrtP - sqrtPnew);
    return Math.max(0, amountOutRaw / 10 ** d1);
  } else {
    // oneForZero: token1 in, token0 out, price INCREASES
    const amountInRaw      = amountIn * 10 ** d1;
    const amountInAfterFee = amountInRaw * (1 - feeFrac);
    // √P_new = √P + Δy / L
    const sqrtPnew = sqrtP + amountInAfterFee / L;
    if (!Number.isFinite(sqrtPnew) || sqrtPnew <= sqrtP) return 0;
    // Δx = L · (√P_new − √P) / (√P_new · √P)  [raw token0 out]
    const product = sqrtPnew * sqrtP;
    if (product <= 0) return 0;
    const amountOutRaw = (L * (sqrtPnew - sqrtP)) / product;
    return Math.max(0, amountOutRaw / 10 ** d0);
  }
}

/**
 * Enumerate and rank candidate routes between fromToken and toToken.
 *
 * What we consider:
 *   1. Direct V3 / V2 (for V3, all fee tiers compete)
 *   2. One-hop V3-only or V2-only via any shared intermediate (A → WKRC → B)
 *
 * What we DON'T consider:
 *   - Mixed V2/V3 paths — would need a custom multicall router, not just
 *     swapExactTokensForTokens + exactInput. Not worth it for 3 tokens.
 *   - 2+ hops — over-engineering for the 3-token registry.
 *   - Split routing (fill from multiple pools) — needs Quoter + liquidity math.
 *
 * Scoring:
 *   - Each candidate is SIMULATED at `amountIn` to compute estimatedOut.
 *     V2: exact x·y=k with fee. V3: within-tick sqrtPrice math (slot0 + L).
 *   - Ranking is by estimatedOut DESC — this is what captures price impact.
 *     A candidate with a great spot rate but thin liquidity (big impact)
 *     will lose to a worse-spot but deeper-liquidity route at high amountIn.
 *   - Ties broken by: single-hop > multi-hop (gas), then V3 > V2 (tighter pricing).
 *
 * Default amountIn = 1 is used when no amount is entered yet; result is
 * effectively "which route has the best spot price" since all candidates
 * see the same trivial impact at size 1.
 *
 * Returns a sorted array — index 0 is the best route. Empty if no route connects.
 */
export function rankRoutes(
  pools: PoolState[],
  fromToken: Token,
  toToken: Token,
  amountIn: number = 1,
): Route[] {
  if (eq(fromToken.address, toToken.address)) return [];
  const size = amountIn > 0 && Number.isFinite(amountIn) ? amountIn : 1;

  const v3Pools = pools.filter((p) => p.version === "v3");
  const v2Pools = pools.filter((p) => p.version === "v2");
  const candidates: Route[] = [];

  // ── Direct single-hop candidates (both versions) ───────────────────────────
  for (const p of [...v3Pools, ...v2Pools]) {
    const directMatch =
      (eq(p.token0.address, fromToken.address) && eq(p.token1.address, toToken.address)) ||
      (eq(p.token1.address, fromToken.address) && eq(p.token0.address, toToken.address));
    if (!directMatch) continue;

    const fromIs0 = eq(p.token0.address, fromToken.address);
    const rate = fromIs0 ? p.price1Per0 : p.price0Per1;
    if (!Number.isFinite(rate) || rate <= 0) continue;

    const rawOut = simulateHop(p, fromToken.address, size);
    if (rawOut <= 0) continue;
    // 안전 상한 — multi-hop 과 동일 이유로 spot × (1-fee) 위로는 못 가게.
    const spotMaxOut = size * rate * (1 - p.fee / 1_000_000);
    const estimatedOut = Math.min(rawOut, spotMaxOut);

    candidates.push({
      kind: p.version === "v3" ? "v3-single" : "v2-single",
      version: p.version,
      hops: [{ pool: p, tokenIn: fromToken, tokenOut: toToken, fee: p.fee }],
      tokenIn: fromToken,
      tokenOut: toToken,
      rate,
      estimatedOut,
      amountIn: size,
      feeFraction: p.fee / 1_000_000,
      path: [fromToken, toToken],
    });
  }

  // ── One-hop candidates (homogeneous V2 or V3) ──────────────────────────────
  // We only chain pools of the same version because the router contracts are
  // different: V3 uses exactInput(path bytes), V2 uses swapExactTokensForTokens
  // (address[]). Mixing would need a multicall contract we don't have.
  for (const group of [v3Pools, v2Pools]) {
    const version: RouteVersion = group === v3Pools ? "v3" : "v2";
    for (const first of group) {
      const firstHasFrom =
        eq(first.token0.address, fromToken.address) ||
        eq(first.token1.address, fromToken.address);
      if (!firstHasFrom) continue;

      const intermediate = eq(first.token0.address, fromToken.address)
        ? first.token1
        : first.token0;
      if (eq(intermediate.address, fromToken.address)) continue;
      if (eq(intermediate.address, toToken.address)) continue;

      const rate1 = eq(first.token0.address, fromToken.address)
        ? first.price1Per0
        : first.price0Per1;
      if (!Number.isFinite(rate1) || rate1 <= 0) continue;

      for (const second of group) {
        if (eq(second.address, first.address)) continue;

        const secondFromIs0 = eq(second.token0.address, intermediate.address);
        const secondFromIs1 = eq(second.token1.address, intermediate.address);
        if (!secondFromIs0 && !secondFromIs1) continue;

        const other = secondFromIs0 ? second.token1 : second.token0;
        if (!eq(other.address, toToken.address)) continue;

        const rate2 = secondFromIs0 ? second.price1Per0 : second.price0Per1;
        if (!Number.isFinite(rate2) || rate2 <= 0) continue;

        // Simulate the full path: size → first → intermediate → second → out.
        // This chains impact correctly: if the first hop drained reserves,
        // the second hop's input is what ACTUALLY arrives post-impact.
        const midOut = simulateHop(first, fromToken.address, size);
        if (midOut <= 0) continue;
        const rawOut = simulateHop(second, intermediate.address, midOut);
        if (rawOut <= 0) continue;

        // 안전 상한: 어떤 multi-hop 도 zero-impact spot rate × (1-fee) 보다 더
        // 받을 수 없음. 시뮬레이터가 그보다 크게 예측하면 (얕은 풀 / 정수 정밀도
        // 이슈 등) downstream 의 amountOutMinimum 계산이 실제 tx 가 만족 못하는
        // 값이 되어 revert. 보수적으로 cap 해서 swap 실패 줄임.
        const cumFeeFraction =
          1 - (1 - first.fee / 1_000_000) * (1 - second.fee / 1_000_000);
        const spotMaxOut = size * rate1 * rate2 * (1 - cumFeeFraction);
        const estimatedOut = Math.min(rawOut, spotMaxOut);

        candidates.push({
          kind: version === "v3" ? "v3-multi" : "v2-multi",
          version,
          hops: [
            { pool: first, tokenIn: fromToken, tokenOut: intermediate, fee: first.fee },
            { pool: second, tokenIn: intermediate, tokenOut: toToken, fee: second.fee },
          ],
          tokenIn: fromToken,
          tokenOut: toToken,
          rate: rate1 * rate2,
          estimatedOut,
          amountIn: size,
          feeFraction:
            1 - (1 - first.fee / 1_000_000) * (1 - second.fee / 1_000_000),
          path: [fromToken, intermediate, toToken],
        });
      }
    }
  }

  // ── Multi-hop sanity demotion vs direct route ─────────────────────────
  // 얕은 풀 / tick-crossing 으로 multi-hop 시뮬레이션이 실제 결과를 크게
  // 과대추정하는 경우가 잦다. Direct pool 이 같은 페어에 존재하는데 multi-hop
  // 예측이 direct × MULTI_HOP_TRUST_RATIO 보다 비현실적으로 좋으면 시뮬레이터
  // 오류로 보고 multi-hop 을 direct 보다 낮은 추정치로 demote — 결과적으로
  // 랭킹에서 direct 가 이김 (direct 는 1풀만 보니까 simulator 정확도 훨씬 좋음).
  //
  // 1.2x 이내면 가격 차이가 정말 있을 수도 있으므로 그대로 두고 raw 비교.
  // 1.2x+ 는 거의 시뮬레이터 오류라 보고 multi-hop 을 0.99 × direct 로 깎아서
  // ranking 시 direct 가 자동으로 선택되게 함.
  const MULTI_HOP_TRUST_RATIO = 1.2;
  const bestDirect = candidates
    .filter((c) => c.hops.length === 1)
    .reduce(
      (best, c) => (c.estimatedOut > best ? c.estimatedOut : best),
      0,
    );
  if (bestDirect > 0) {
    for (const c of candidates) {
      if (c.hops.length === 1) continue;
      const trustCap = bestDirect * MULTI_HOP_TRUST_RATIO;
      if (c.estimatedOut > trustCap) {
        // 의심스러운 multi-hop — direct 보다 약간 낮게 demote 해서 direct 가
        // 항상 이기게. 사용자는 direct 로 swap 하게 됨 (안전).
        c.estimatedOut = bestDirect * 0.99;
      }
    }
  }

  // Rank: higher estimatedOut first (this is what captures price impact);
  // ties → prefer single-hop (less gas), then V3 (sharper pricing).
  candidates.sort((a, b) => {
    if (b.estimatedOut !== a.estimatedOut) return b.estimatedOut - a.estimatedOut;
    if (a.hops.length !== b.hops.length) return a.hops.length - b.hops.length;
    if (a.version !== b.version) return a.version === "v3" ? -1 : 1;
    return 0;
  });
  return candidates;
}

/**
 * Convenience wrapper — returns just the top-ranked route, or null if none exists.
 * Most call sites want this. Use `rankRoutes` if you need the runners-up
 * (e.g. to show a "V3 대비 X TKA 유리" comparison in the UI).
 */
export function findBestRoute(
  pools: PoolState[],
  fromToken: Token,
  toToken: Token,
  amountIn: number = 1,
): Route | null {
  const ranked = rankRoutes(pools, fromToken, toToken, amountIn);
  return ranked[0] ?? null;
}

/** Token-address sequence for V2 swapExactTokensForTokens path arg. */
export function v2Path(route: Route): `0x${string}`[] {
  if (route.version !== "v2") throw new Error("v2Path called on non-V2 route");
  return [
    route.hops[0].tokenIn.address,
    ...route.hops.map((h) => h.tokenOut.address),
  ];
}

/**
 * Encode a V3 exactInput path:
 *   tokenIn (20 bytes) + fee (uint24, 3 bytes BE) + tokenNext (20 bytes) + fee + ... + tokenOut
 *
 * Used by SwapRouter.exactInput. Works for any number of hops ≥ 1, though
 * for 1-hop exactInputSingle is cheaper — call sites should dispatch on
 * route.kind rather than always encoding.
 */
export function encodeV3Path(hops: RouteHop[]): `0x${string}` {
  if (hops.length === 0) throw new Error("cannot encode empty route");
  for (let i = 1; i < hops.length; i++) {
    if (!eq(hops[i - 1].tokenOut.address, hops[i].tokenIn.address)) {
      throw new Error(
        `route hops are not contiguous at index ${i}: ${hops[i - 1].tokenOut.symbol} ≠ ${hops[i].tokenIn.symbol}`,
      );
    }
  }

  let hex = hops[0].tokenIn.address.slice(2).toLowerCase();
  for (const h of hops) {
    if (h.fee < 0 || h.fee > 0xffffff) throw new Error(`fee out of uint24 range: ${h.fee}`);
    hex += h.fee.toString(16).padStart(6, "0");
    hex += h.tokenOut.address.slice(2).toLowerCase();
  }
  return ("0x" + hex) as `0x${string}`;
}
