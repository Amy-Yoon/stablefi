"use client";

import { useQuery } from "@tanstack/react-query";

// ── V3 NFT 미수령 수수료 정확 조회 훅 ───────────────────────────────────
// /api/position-fees 가 simulateContract 로 collect() 시뮬레이션해서 정확한
// 누적 fee 반환. tokensOwed 만으로 못 잡는 "누적됐지만 아직 crystallize 안 된"
// fee 까지 캡처 — 풀이 idle 한 사용자 range 에서도 정확.

export interface PositionFee {
  amount0Raw: string;
  amount1Raw: string;
}

export interface PositionFeesResponse {
  fees: Record<string, PositionFee>;
  error?: string;
}

export function usePositionFees(
  owner: `0x${string}` | undefined,
  tokenIds: bigint[],
) {
  const stableKey = tokenIds.map((id) => id.toString()).sort().join(",");

  return useQuery<PositionFeesResponse>({
    queryKey: ["positionFees", owner?.toLowerCase(), stableKey],
    queryFn: async () => {
      if (!owner || tokenIds.length === 0) return { fees: {} };
      const ids = tokenIds.map((id) => id.toString()).join(",");
      const res = await fetch(`/api/position-fees?owner=${owner}&tokenIds=${ids}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: !!owner && tokenIds.length > 0,
    // 미수령 수수료는 swap 마다 변하지만 분 단위 정밀도로 충분. 1분 캐시.
    staleTime: 1000 * 60,
    refetchInterval: 1000 * 60 * 3,
    retry: 1,
  });
}
