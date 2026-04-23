"use client";

import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import type { Abi } from "viem";
import { publicClient } from "@/lib/client";
import ERC20Json from "@/lib/abi/ERC20.json";
import { fetchV2Pool, fetchV3Pool, type PoolState } from "./usePool";
import { useMyPositions } from "./useMyPositions";
import { useMyV2Positions } from "./useMyV2Positions";
import { useWallet } from "@/context/WalletContext";
import type { PoolRef } from "@/lib/chain";
import type { Pool } from "@/components/pool/PoolList";

const ERC20 = ERC20Json as Abi;

/**
 * Fetch many pools in parallel plus the 2 balances per pool needed to compute
 * WKRC-equivalent TVL.
 *
 * Cross-pool pricing: we build a `wkrcPrices` map — for every token we can
 * reach WKRC from (directly via a TOKEN/WKRC pair), store its WKRC price.
 * This lets us value even pools that don't have WKRC on either side
 * (e.g. TokenA-TokenB) by looking up each side's WKRC price.
 *
 * One-hop only — no multi-hop routing. When both V2 and V3 have a WKRC pair
 * for the same token, V3's quote wins (tighter concentrated liquidity usually
 * means the spot price is closer to mid-market).
 */
export function usePoolsAggregate(refs: PoolRef[]) {
  // Step 1 — every pool
  const poolQueries = useQueries({
    queries: refs.map((ref) => ({
      queryKey: ["pool", ref.address.toLowerCase(), ref.version],
      queryFn: async () =>
        ref.version === "v3" ? fetchV3Pool(ref.address) : fetchV2Pool(ref.address),
      // 6 pools × 30s = 12/min baseline — too aggressive on public RPC.
      // Cached 2min, refetch 5min. Users get fresh data on nav / focus.
      staleTime: 1000 * 60 * 2,
      refetchInterval: 1000 * 60 * 5,
      retry: 1,
    })),
  });

  // Step 2 — for every successfully-loaded pool, 2 balanceOf reads (pool holds
  // the reserves). Flat list so useQueries signature is stable across renders.
  const balanceTargets: { token: `0x${string}`; account: `0x${string}` }[] = [];
  poolQueries.forEach((q, i) => {
    const state = q.data;
    if (!state) return;
    balanceTargets.push({ token: state.token0.address, account: refs[i].address });
    balanceTargets.push({ token: state.token1.address, account: refs[i].address });
  });

  const balanceQueries = useQueries({
    queries: balanceTargets.map((t) => ({
      queryKey: ["tokenBalance", t.token.toLowerCase(), t.account.toLowerCase()],
      queryFn: () =>
        publicClient.readContract({
          address: t.token,
          abi: ERC20,
          functionName: "balanceOf",
          args: [t.account],
        }) as Promise<bigint>,
      // 6 pools × 30s = 12/min baseline — too aggressive on public RPC.
      // Cached 2min, refetch 5min. Users get fresh data on nav / focus.
      staleTime: 1000 * 60 * 2,
      refetchInterval: 1000 * 60 * 5,
      retry: 1,
    })),
  });

  const loading = poolQueries.some((q) => q.isLoading);

  // Gather successful states first so we can build the price map
  const loadedStates: PoolState[] = [];
  poolQueries.forEach((q) => {
    if (q.data) loadedStates.push(q.data as PoolState);
  });

  const wkrcPrices = useMemo(
    () => buildWkrcPrices(loadedStates),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loadedStates.map((s) => `${s.address}:${s.price1Per0}:${s.price0Per1}`).join("|")],
  );

  // User's V3 NFT positions + V2 LP shares, each aggregated per pool. Both
  // require states+prices to be loaded (pass empty arrays pre-load so the
  // hooks short-circuit cleanly). Combined below so home/pool list/withdraw
  // see a single map regardless of version.
  const { address: owner } = useWallet();
  const myV3Positions = useMyPositions(
    owner as `0x${string}` | undefined,
    loadedStates,
    wkrcPrices,
  );
  const myV2Positions = useMyV2Positions(
    owner as `0x${string}` | undefined,
    loadedStates,
    wkrcPrices,
  );
  const myPositionsByPool = { ...myV3Positions.byPool, ...myV2Positions.byPool };
  const myDepositedTotalWKRC =
    myV3Positions.totalDepositedWKRC + myV2Positions.totalDepositedWKRC;
  const myEarnedTotalWKRC =
    myV3Positions.totalEarnedWKRC + myV2Positions.totalEarnedWKRC;

  // Walk balances back onto the pool rows in insertion order
  const balIter = balanceQueries[Symbol.iterator]();

  const pools: Pool[] = [];
  const states: PoolState[] = [];
  const errors: { label: string; message: string }[] = [];

  poolQueries.forEach((q, i) => {
    const ref = refs[i];
    const state = q.data as PoolState | undefined;
    if (q.error) {
      errors.push({
        label: ref.label ?? ref.address.slice(0, 8),
        message:
          (q.error as any)?.shortMessage ??
          (q.error as any)?.message ??
          String(q.error),
      });
      return;
    }
    if (!state) return;

    const b0 = balIter.next().value?.data as bigint | undefined;
    const b1 = balIter.next().value?.data as bigint | undefined;

    // TVL in WKRC terms — needs a known WKRC price for BOTH sides
    let tvlWKRC: number | undefined;
    if (b0 !== undefined && b1 !== undefined) {
      const b0Human = Number(b0) / 10 ** state.token0.decimals;
      const b1Human = Number(b1) / 10 ** state.token1.decimals;
      const p0 = wkrcPrices[state.token0.address.toLowerCase()];
      const p1 = wkrcPrices[state.token1.address.toLowerCase()];
      if (p0 !== undefined && p1 !== undefined) {
        tvlWKRC = b0Human * p0 + b1Human * p1;
      }
    }

    const myPos = myPositionsByPool[state.address.toLowerCase()];
    pools.push({
      address: state.address,
      version: state.version,
      token0: state.token0,
      token1: state.token1,
      fee: state.fee,
      tvlWKRC,
      myDepositedWKRC: myPos?.depositedWKRC,
      myEarnedWKRC: myPos?.earnedWKRC,
      myPositionSlices: myPos?.positions,
    });
    states.push(state);
  });

  return {
    pools,
    states,
    wkrcPrices,
    loading,
    errors,
    myPositionsByPool,
    myDepositedTotalWKRC,
    myEarnedTotalWKRC,
  };
}

/**
 * Build a token-address → WKRC-price map using every known pool.
 * - WKRC itself → 1
 * - For any pool with WKRC on one side, the opposite token gets a price
 *   (V3 preferred over V2 as tie-breaker via ordering)
 */
function buildWkrcPrices(states: PoolState[]): Record<string, number> {
  const prices: Record<string, number> = {};

  // V3 first so V2 can only fill in for tokens V3 doesn't cover
  const ordered = [...states].sort((a, b) =>
    a.version === b.version ? 0 : a.version === "v3" ? -1 : 1,
  );

  for (const s of ordered) {
    const t0 = s.token0.address.toLowerCase();
    const t1 = s.token1.address.toLowerCase();
    const isWKRC0 = s.token0.symbol === "WKRC";
    const isWKRC1 = s.token1.symbol === "WKRC";

    if (isWKRC0) prices[t0] = 1;
    if (isWKRC1) prices[t1] = 1;

    if (isWKRC0 && !isWKRC1) {
      // 1 token1 = price0Per1 WKRC
      if (prices[t1] === undefined) prices[t1] = s.price0Per1;
    } else if (isWKRC1 && !isWKRC0) {
      // 1 token0 = price1Per0 WKRC
      if (prices[t0] === undefined) prices[t0] = s.price1Per0;
    }
  }

  return prices;
}
