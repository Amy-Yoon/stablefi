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
import { formatUnits, type Abi } from "viem";
import { publicClient } from "@/lib/client";
import { CONTRACTS } from "@/lib/chain";
import PositionManagerJson from "@/lib/abi/PositionManager.json";
import { positionAmounts } from "@/lib/v3Range";
import { usePositionHistory } from "./usePositionHistory";
import { usePositionFees } from "./usePositionFees";
import type { PoolState } from "./usePool";

const PositionManager = PositionManagerJson as Abi;

// effective APR 안전장치 — 데이터 부족하거나 너무 짧은 보유기간이면 noise 큼.
// 1일 미만 + 수수료 거의 없는 케이스는 의미 없는 큰 % 가 튀어나오므로 표시 안 함.
const MIN_DAYS_FOR_APR = 0.5; // 12시간 미만이면 effective APR 노출 X
// 비현실적으로 큰 값은 "초기 단계 풀 노이즈" 로 보고 캡 — 1000% 넘으면 그냥 ">1000%".
const APR_DISPLAY_CAP = 1000;

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
  /** 누적 수령 수수료 (Collect 이벤트 합산, 원금 추정 차감 후). 모든 포지션 합. */
  realizedFeesWKRC?: number;
  /** 가장 오래된 mint 시각 (unix sec). 풀 단위 effective APR 표시용. */
  oldestMintTimestamp?: number;
  /** 풀 단위 weighted-avg effective APR (deposited 가중). undefined = 데이터 부족. */
  effectiveAPR?: number;
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
    /** Per-position 진입 시각 — history endpoint 가 lookback 안에서 잡아야 채움. */
    mintTimestamp?: number;
    /** Per-position 연 환산 수익률 (%). undefined = 데이터 부족. */
    effectiveAPR?: number;
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

  // 활성 포지션의 tokenId 만 history 에 보냄 — fully-withdrawn tombstone 까지
  // 보낼 필요 없음. liquidity 도 0 이고 fee 도 0 인 건 무시.
  const activeTokenIds = posQueries
    .map((q) => q.data)
    .filter((p): p is RawPosition => {
      if (!p) return false;
      if (p.liquidity === 0n && p.tokensOwed0 === 0n && p.tokensOwed1 === 0n) return false;
      return true;
    })
    .map((p) => p.tokenId);

  const { data: historyData } = usePositionHistory(activeTokenIds);
  const histories = historyData?.histories ?? {};

  // tokensOwed 는 swap 이 사용자 range 를 거칠 때만 갱신되어 보수적임. 실제
  // 누적된 fee 는 collect() simulateContract 로만 정확. fees data 가 도착하면
  // 그걸 owed0/owed1 대신 사용해서 진짜 누적 fee 를 earnedWKRC 로 반영.
  const { data: feesData } = usePositionFees(owner, activeTokenIds);
  const simulatedFees = feesData?.fees ?? {};

  const loading =
    (owner && count === undefined) ||
    idxQueries.some((q) => q.isLoading) ||
    posQueries.some((q) => q.isLoading);

  // Aggregate by pool address (matching position → state via token0+token1+fee)
  const byPool = useMemo(() => {
    const map: Record<string, MyPoolPosition> = {};
    const nowSec = Math.floor(Date.now() / 1000);

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
      // owed0/owed1: simulateContract collect 결과가 우선 (정확한 누적 fee).
      // 응답 도착 전이면 chain 의 tokensOwed (보수적) 으로 fallback.
      const sim = simulatedFees[p.tokenId.toString()];
      const owed0Wei = sim ? BigInt(sim.amount0Raw) : p.tokensOwed0;
      const owed1Wei = sim ? BigInt(sim.amount1Raw) : p.tokensOwed1;
      const owed0 = parseFloat(formatUnits(owed0Wei, state.token0.decimals));
      const owed1 = parseFloat(formatUnits(owed1Wei, state.token1.decimals));

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

      // ── 진입 시각 + 누적 수령 수수료 + effective APR ─────────────────────
      // history 응답이 도착했고 lookback 범위 안에 mint 가 잡혔을 때만 계산.
      // 안 잡히면 undefined 그대로 두고 UI 가 fallback (수수료만 표시).
      const h = histories[p.tokenId.toString()];
      let mintTimestamp: number | undefined;
      let effectiveAPR: number | undefined;
      let positionRealizedFeesWKRC = 0;

      if (h?.mintTimestamp) {
        mintTimestamp = Number(h.mintTimestamp);
        const daysSinceMint = (nowSec - mintTimestamp) / 86400;

        // 누적 collect - 누적 decrease = 수수료로 빼간 양 (대략).
        // decrease + collect 가 같은 tx 에 있으면 collect 안에 원금이 섞여있어서
        // (collect - decrease) 가 순수 fee. 단독 collect 였으면 decrease=0 이라
        // 그대로 collect 양이 fee.
        const decimals0 = state.token0.decimals;
        const decimals1 = state.token1.decimals;
        const realized0 = Math.max(
          0,
          parseFloat(formatUnits(BigInt(h.collected0Raw), decimals0)) -
            parseFloat(formatUnits(BigInt(h.grossWithdraw0Raw), decimals0)),
        );
        const realized1 = Math.max(
          0,
          parseFloat(formatUnits(BigInt(h.collected1Raw), decimals1)) -
            parseFloat(formatUnits(BigInt(h.grossWithdraw1Raw), decimals1)),
        );
        positionRealizedFeesWKRC =
          (pw0 !== undefined ? realized0 * pw0 : 0) +
          (pw1 !== undefined ? realized1 * pw1 : 0);

        // 총 수수료 = 실현(이미 받음) + 미실현(tokensOwed). 이걸 진입 가치 대비
        // 환산 + 시간 정규화. principal 은 현재 포지션 가치 (positionAmounts)
        // 를 사용 — grossDeposit 보다 안정적 (가격 변동 노이즈 적음).
        if (
          daysSinceMint >= MIN_DAYS_FOR_APR &&
          depositedWKRC > 0 &&
          (positionRealizedFeesWKRC > 0 || earnedWKRC > 0)
        ) {
          const totalFeesWKRC = positionRealizedFeesWKRC + earnedWKRC;
          effectiveAPR = (totalFeesWKRC / depositedWKRC) * (365 / daysSinceMint) * 100;
        }
      }

      const key = state.address.toLowerCase();
      if (!map[key]) {
        map[key] = {
          depositedWKRC: 0,
          earnedWKRC: 0,
          realizedFeesWKRC: 0,
          oldestMintTimestamp: undefined,
          effectiveAPR: undefined,
          positions: [],
        };
      }
      map[key].depositedWKRC += depositedWKRC;
      map[key].earnedWKRC += earnedWKRC;
      map[key].realizedFeesWKRC = (map[key].realizedFeesWKRC ?? 0) + positionRealizedFeesWKRC;
      if (
        mintTimestamp !== undefined &&
        (map[key].oldestMintTimestamp === undefined ||
          mintTimestamp < map[key].oldestMintTimestamp!)
      ) {
        map[key].oldestMintTimestamp = mintTimestamp;
      }
      map[key].positions.push({
        tokenId: p.tokenId,
        tickLower: p.tickLower,
        tickUpper: p.tickUpper,
        liquidity: p.liquidity,
        amount0,
        amount1,
        owed0,
        owed1,
        mintTimestamp,
        effectiveAPR,
      });
    }

    // 풀별 weighted-avg effective APR — 각 포지션의 APR 을 depositedWKRC 로 가중평균.
    // 한 포지션도 effective APR 못 구하면 풀 단위는 undefined 로 둔다.
    for (const key of Object.keys(map)) {
      const pp = map[key];
      let weighted = 0;
      let weightSum = 0;
      let anyAPR = false;
      for (const pos of pp.positions) {
        if (pos.effectiveAPR === undefined) continue;
        const w = pos.amount0 + pos.amount1; // 가중치는 raw human amount 합 — 같은 풀이라 통화 단위 무관
        if (w <= 0) continue;
        weighted += pos.effectiveAPR * w;
        weightSum += w;
        anyAPR = true;
      }
      if (anyAPR && weightSum > 0) {
        pp.effectiveAPR = weighted / weightSum;
      }
    }

    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    posQueries.map((q) => q.data?.tokenId.toString() + ":" + q.data?.liquidity.toString()).join("|"),
    states.map((s) => `${s.address}:${s.sqrtPriceX96}`).join("|"),
    Object.entries(wkrcPrices).map(([k, v]) => `${k}:${v}`).join("|"),
    Object.entries(histories).map(([id, h]) => `${id}:${h.mintTimestamp}:${h.collected0Raw}:${h.collected1Raw}`).join("|"),
    Object.entries(simulatedFees).map(([id, f]) => `${id}:${f.amount0Raw}:${f.amount1Raw}`).join("|"),
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
