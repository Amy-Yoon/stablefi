"use client";

import { useQuery } from "@tanstack/react-query";
import { readWalletBlockNumber } from "@/lib/pendingTxs";
import type { PoolState } from "./usePool";

// ── 풀 24h volume / fee stats 훅 ──────────────────────────────────────────
// /api/pool-stats 호출 결과를 React Query 로 감싸서 캐시. 결과는 풀 주소
// (lowercase) 키 dict 로 받아서 usePoolsAggregate 가 바로 합성.
//
// 24h 통계는 분 단위로 변하지 않으니 staleTime 5분 / refetchInterval 10분 이면
// RPC 부담도 적고 사용자 체감도 거의 실시간.

export interface PoolStats {
  fee0Raw: string;
  fee1Raw: string;
  volume0Raw: string;
  volume1Raw: string;
  swapCount: number;
}

export interface PoolStatsResponse {
  stats: Record<string, PoolStats>;
  error?: string;
  debug?: Record<string, unknown>;
}

/**
 * @param states - 통계 받을 풀들. 각 풀의 fee tier 가 V3 면 millionths,
 *                 V2 면 항상 3000 으로 서버에서 처리. states 가 비어있으면
 *                 query 자체가 실행 안 됨.
 */
export function usePoolStats(states: PoolState[]) {
  // queryKey 안정화 — states 객체 reference 가 바뀌어도 같은 풀 셋이면 dedup.
  const stableKey = states
    .map((s) => `${s.address.toLowerCase()}:${s.version}:${s.fee}`)
    .sort()
    .join(",");

  return useQuery<PoolStatsResponse>({
    queryKey: ["poolStats", stableKey],
    queryFn: async () => {
      if (states.length === 0) return { stats: {} };
      const poolsParam = states
        .map((s) => `${s.address}:${s.version}:${s.fee}`)
        .join(",");
      // 활동 API 와 동일한 wallet block hint — RPC stale 우회.
      const walletBlock = await readWalletBlockNumber();
      const hint =
        walletBlock > 0n ? `&clientLatest=${walletBlock.toString()}` : "";
      const res = await fetch(`/api/pool-stats?pools=${poolsParam}${hint}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: states.length > 0,
    staleTime: 1000 * 60 * 5,
    refetchInterval: 1000 * 60 * 10,
    retry: 1,
  });
}
