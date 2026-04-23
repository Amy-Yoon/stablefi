"use client";

// Read the user's Uniswap V3 NonfungiblePositionManager NFT positions and
// map them back onto our KNOWN_POOLS list. We fetch:
//   1. balanceOf(owner) → how many NFTs they hold
//   2. tokenOfOwnerByIndex(owner, i) → each tokenId
//   3. positions(tokenId) → the on-chain position struct
//
// For every position we compute the token0/token1 amounts locked via
// `positionAmounts()` (Uniswap V3 √p math), value both sides in WKRC using
// the cross-pool `wkrcPrices` map, and aggregate per pool address so the
// pool list can display "맡긴 금액" and "꺼내기" can list a real position.
//
// `tokensOwed0/1` from the position struct is used as a rough earned-fee
// floor — it only updates on certain pool interactions, so fresh positions
// will show 0 until they're poked. Accurate fee accounting requires
// collect() staticCall which is deferred.

import { useMemo } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import type { Abi } from "viem";
import { publicClient } from "@/lib/client";
import { CONTRACTS } from "@/lib/chain";
import PositionManagerJson from "@/lib/abi/PositionManager.json";
import { positionAmounts } from "@/lib/v3Range";
import type { PoolState } from "./usePool";

const PositionManager = PositionManagerJson as Abi;

/** Shape returned by PositionManager.positions(tokenId). */
export interface RawPosition {
  tokenId: bigint;
  token0: `0x${string}`;
  token1: `0x${string}`;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}

/** Per-pool aggregate derived from a user's positions. */
export interface MyPoolPosition {
  depositedWKRC: number;
  earnedWKRC: number;
  positions: Array<{
    tokenId: bigint;
    tickLower: number;
    tickUpper: number;
    /** Raw liquidity — V3: position.liquidity, V2: LP balance. */
    liquidity: bigint;
    amount0: number;
    amount1: number;
    owed0: number;
    owed1: number;
  }>;
}

/**
 * Read how many V3 position NFTs the given owner holds. Cached at 2min so
 * mint transactions (which invalidate this key) can refresh it; idle pages
 * don't hammer RPC.
 */
export function useMyPositionCount(owner: `0x${string}` | undefined) {
  return useQuery({
    queryKey: ["myPositionCount", owner?.toLowerCase()],
    queryFn: async () => {
      if (!owner) return 0n;
      const n = (await publicClient.readContract({
        address: CONTRACTS.v3PositionManager,
        abi: PositionManager,
        functionName: "balanceOf",
        args: [owner],
      })) as bigint;
      return n;
    },
    enabled: !!owner,
    staleTime: 1000 * 60 * 2,
    refetchInterval: 1000 * 60 * 5,
    retry: 1,
  });
}

/**
 * Full pipeline: NFT count → tokenIds → positions structs. Returns a map keyed
 * by pool address (lowercased) and a flat list for other consumers.
 */
export function useMyPositions(
  owner: `0x${string}` | undefined,
  states: PoolState[],
  wkrcPrices: Record<string, number>,
) {
  const { data: count } = useMyPositionCount(owner);
  const n = count ? Number(count) : 0;

  // Step 2: tokenOfOwnerByIndex for each slot
  const idxQueries = useQueries({
    queries: Array.from({ length: n }).map((_, i) => ({
      queryKey: ["myTokenId", owner?.toLowerCase(), i],
      queryFn: async () => {
        return (await publicClient.readContract({
          address: CONTRACTS.v3PositionManager,
          abi: PositionManager,
          functionName: "tokenOfOwnerByIndex",
          args: [owner!, BigInt(i)],
        })) as bigint;
      },
      enabled: !!owner,
      staleTime: 1000 * 60 * 2,
      refetchInterval: 1000 * 60 * 5,
      retry: 1,
    })),
  });

  const tokenIds = idxQueries.map((q) => q.data).filter((v): v is bigint => v !== undefined);

  // Step 3: positions(tokenId) for each tokenId
  const posQueries = useQueries({
    queries: tokenIds.map((tokenId) => ({
      queryKey: ["v3Position", tokenId.toString()],
      queryFn: async () => {
        const raw = (await publicClient.readContract({
          address: CONTRACTS.v3PositionManager,
          abi: PositionManager,
          functionName: "positions",
          args: [tokenId],
        })) as readonly [
          bigint, `0x${string}`, `0x${string}`, `0x${string}`, number,
          number, number, bigint, bigint, bigint, bigint, bigint,
        ];
        const pos: RawPosition = {
          tokenId,
          token0: raw[2],
          token1: raw[3],
          fee: Number(raw[4]),
          tickLower: Number(raw[5]),
          tickUpper: Number(raw[6]),
          liquidity: raw[7],
          tokensOwed0: raw[10],
          tokensOwed1: raw[11],
        };
        return pos;
      },
      staleTime: 1000 * 60 * 2,
      refetchInterval: 1000 * 60 * 5,
      retry: 1,
    })),
  });

  const loading =
    (owner && count === undefined) ||
    idxQueries.some((q) => q.isLoading) ||
    posQueries.some((q) => q.isLoading);

  // Aggregate by pool address (matching position → state via token0+token1+fee)
  const byPool = useMemo(() => {
    const map: Record<string, MyPoolPosition> = {};
    for (const q of posQueries) {
      const p = q.data;
      if (!p) continue;
      // Skip fully-withdrawn positions with 0 liquidity AND 0 owed — they're
      // tombstones. Positions with 0 liquidity but non-zero owed still count
      // (user has unclaimed fees to collect).
      if (p.liquidity === 0n && p.tokensOwed0 === 0n && p.tokensOwed1 === 0n) continue;

      const state = states.find(
        (s) =>
          s.version === "v3" &&
          s.token0.address.toLowerCase() === p.token0.toLowerCase() &&
          s.token1.address.toLowerCase() === p.token1.toLowerCase() &&
          s.fee === p.fee,
      );
      if (!state || state.sqrtPriceX96 === undefined) continue;

      const { amount0, amount1 } = positionAmounts(
        p.liquidity,
        state.sqrtPriceX96,
        p.tickLower,
        p.tickUpper,
        state.token0.decimals,
        state.token1.decimals,
      );
      const owed0 = Number(p.tokensOwed0) / 10 ** state.token0.decimals;
      const owed1 = Number(p.tokensOwed1) / 10 ** state.token1.decimals;

      const pw0 = wkrcPrices[state.token0.address.toLowerCase()];
      const pw1 = wkrcPrices[state.token1.address.toLowerCase()];
      // If we can't price a side in WKRC, skip it rather than 0-valuing it.
      // Better to undercount than to show a bogus total.
      const depositedWKRC =
        (pw0 !== undefined ? amount0 * pw0 : 0) +
        (pw1 !== undefined ? amount1 * pw1 : 0);
      const earnedWKRC =
        (pw0 !== undefined ? owed0 * pw0 : 0) +
        (pw1 !== undefined ? owed1 * pw1 : 0);

      const key = state.address.toLowerCase();
      if (!map[key]) map[key] = { depositedWKRC: 0, earnedWKRC: 0, positions: [] };
      map[key].depositedWKRC += depositedWKRC;
      map[key].earnedWKRC += earnedWKRC;
      map[key].positions.push({
        tokenId: p.tokenId,
        tickLower: p.tickLower,
        tickUpper: p.tickUpper,
        liquidity: p.liquidity,
        amount0,
        amount1,
        owed0,
        owed1,
      });
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    posQueries.map((q) => q.data?.tokenId.toString() + ":" + q.data?.liquidity.toString()).join("|"),
    states.map((s) => `${s.address}:${s.sqrtPriceX96}`).join("|"),
    Object.entries(wkrcPrices).map(([k, v]) => `${k}:${v}`).join("|"),
  ]);

  const totalDepositedWKRC = Object.values(byPool).reduce(
    (sum, p) => sum + p.depositedWKRC,
    0,
  );
  const totalEarnedWKRC = Object.values(byPool).reduce(
    (sum, p) => sum + p.earnedWKRC,
    0,
  );

  return { byPool, totalDepositedWKRC, totalEarnedWKRC, loading: !!loading };
}
