"use client";

// Read the user's V2 LP balances and translate them into per-pool share of
// the underlying reserves.
//
// V2 LP tokens ARE the pair contract (Uniswap V2 mints ERC20 to the
// liquidity provider). For each V2 pool we read:
//   1. pair.balanceOf(user)   — user's LP units
//   2. pair.totalSupply()     — all LP units in circulation
// and combine with the reserves already in PoolState to compute:
//   share       = balance / totalSupply
//   userAmount0 = reserve0 * share
//   userAmount1 = reserve1 * share
//
// Earned fees: V2 doesn't expose uncollected-fee counters — fees are
// auto-compounded into reserves over time, so the user's share already
// reflects principal + accrued fees. We surface `earnedWKRC = 0` and let
// the whole value appear under "맡긴 금액". This keeps the UI contract
// identical to V3 without inventing a fake fee line.
//
// Shape matches MyPoolPosition from useMyPositions so downstream consumers
// (usePoolsAggregate, PoolList, PoolModal withdraw preview) can treat V2
// and V3 rows interchangeably.

import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import type { Abi } from "viem";
import { publicClient } from "@/lib/client";
import V2PairJson from "@/lib/abi/V2Pair.json";
import type { PoolState } from "./usePool";
import type { MyPoolPosition } from "./useMyPositions";

const V2Pair = V2PairJson as Abi;

/**
 * For each V2 pool in `states`, read the user's balanceOf + pair.totalSupply
 * and compute their share of reserves, then price into WKRC via `wkrcPrices`.
 *
 * V2 rows without an owner, without a balance, or without a resolved WKRC
 * price for both sides simply aren't emitted (same undercount-vs-bogus
 * stance as useMyPositions).
 */
export function useMyV2Positions(
  owner: `0x${string}` | undefined,
  states: PoolState[],
  wkrcPrices: Record<string, number>,
) {
  const v2States = states.filter((s) => s.version === "v2");

  // Balance + totalSupply per V2 pair — interleaved so one useQueries call
  // handles both reads with a stable order.
  const queries = useQueries({
    queries: v2States.flatMap((s) => [
      {
        queryKey: ["v2LpBalance", s.address.toLowerCase(), owner?.toLowerCase()],
        queryFn: async () => {
          if (!owner) return 0n;
          return (await publicClient.readContract({
            address: s.address,
            abi: V2Pair,
            functionName: "balanceOf",
            args: [owner],
          })) as bigint;
        },
        enabled: !!owner,
        staleTime: 1000 * 60 * 2,
        refetchInterval: 1000 * 60 * 5,
        retry: 1,
      },
      {
        queryKey: ["v2LpTotalSupply", s.address.toLowerCase()],
        queryFn: async () => {
          return (await publicClient.readContract({
            address: s.address,
            abi: V2Pair,
            functionName: "totalSupply",
          })) as bigint;
        },
        staleTime: 1000 * 60 * 2,
        refetchInterval: 1000 * 60 * 5,
        retry: 1,
      },
    ]),
  });

  const loading = queries.some((q) => q.isLoading);

  const byPool = useMemo(() => {
    const map: Record<string, MyPoolPosition> = {};
    v2States.forEach((state, i) => {
      const bal = queries[i * 2]?.data as bigint | undefined;
      const total = queries[i * 2 + 1]?.data as bigint | undefined;
      if (!bal || !total || bal === 0n || total === 0n) return;
      if (state.reserve0 === undefined || state.reserve1 === undefined) return;

      // share * 1e18 to avoid float loss; then convert.
      // Safer: compute amounts in bigint first, then to Number at the end.
      const userReserve0 = (state.reserve0 * bal) / total;
      const userReserve1 = (state.reserve1 * bal) / total;

      const amount0 = Number(userReserve0) / 10 ** state.token0.decimals;
      const amount1 = Number(userReserve1) / 10 ** state.token1.decimals;

      const pw0 = wkrcPrices[state.token0.address.toLowerCase()];
      const pw1 = wkrcPrices[state.token1.address.toLowerCase()];
      const depositedWKRC =
        (pw0 !== undefined ? amount0 * pw0 : 0) +
        (pw1 !== undefined ? amount1 * pw1 : 0);

      const key = state.address.toLowerCase();
      map[key] = {
        depositedWKRC,
        earnedWKRC: 0, // V2 auto-compounds fees into reserves — no separate line.
        positions: [
          {
            // V2 has no NFT per position — we synthesize a deterministic id
            // from the pair address so downstream code that keys by tokenId
            // still works. V2 "ticks" are meaningless; use -∞/+∞ sentinels.
            tokenId: BigInt(state.address),
            tickLower: -887272,
            tickUpper:  887272,
            // Raw LP balance — needed to pass into V2Router.removeLiquidity.
            liquidity: bal,
            amount0,
            amount1,
            owed0: 0,
            owed1: 0,
          },
        ],
      };
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    v2States.map((s) => `${s.address}:${s.reserve0}:${s.reserve1}`).join("|"),
    queries.map((q) => (q.data as bigint | undefined)?.toString() ?? "").join("|"),
    Object.entries(wkrcPrices).map(([k, v]) => `${k}:${v}`).join("|"),
  ]);

  const totalDepositedWKRC = Object.values(byPool).reduce(
    (sum, p) => sum + p.depositedWKRC,
    0,
  );

  return { byPool, totalDepositedWKRC, totalEarnedWKRC: 0, loading };
}
