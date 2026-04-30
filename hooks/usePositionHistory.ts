"use client";

import { useQuery } from "@tanstack/react-query";
import { readWalletBlockNumber } from "@/lib/pendingTxs";

// ── V3 NFT 포지션별 히스토리 훅 ─────────────────────────────────────────
// /api/position-history 응답을 React Query 로 감싼 얇은 wrapper. tokenId 배열이
// 비어있으면 query 비활성. 5분 캐시 + 10분 refetch 로 RPC 부담 최소화.

export interface PositionHistory {
  mintBlock?: string;
  mintTimestamp?: string;
  grossDeposit0Raw: string;
  grossDeposit1Raw: string;
  grossWithdraw0Raw: string;
  grossWithdraw1Raw: string;
  collected0Raw: string;
  collected1Raw: string;
  eventCount: {
    transfer: number;
    increase: number;
    decrease: number;
    collect: number;
  };
}

export interface PositionHistoryResponse {
  histories: Record<string, PositionHistory>;
  error?: string;
  debug?: Record<string, unknown>;
}

/**
 * @param tokenIds - V3 NFT id 배열. 비어있으면 query disabled.
 */
export function usePositionHistory(tokenIds: bigint[]) {
  // queryKey 안정화 — 같은 tokenId 셋이면 같은 cache.
  const stableKey = tokenIds
    .map((id) => id.toString())
    .sort()
    .join(",");

  return useQuery<PositionHistoryResponse>({
    queryKey: ["positionHistory", stableKey],
    queryFn: async () => {
      if (tokenIds.length === 0) return { histories: {} };
      const ids = tokenIds.map((id) => id.toString()).join(",");
      const walletBlock = await readWalletBlockNumber();
      const hint =
        walletBlock > 0n ? `&clientLatest=${walletBlock.toString()}` : "";
      const res = await fetch(`/api/position-history?tokenIds=${ids}${hint}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: tokenIds.length > 0,
    staleTime: 1000 * 60 * 5,
    refetchInterval: 1000 * 60 * 10,
    retry: 1,
  });
}
