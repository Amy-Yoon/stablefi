"use client";

import { useQuery } from "@tanstack/react-query";
import { publicClient } from "@/lib/client";

/**
 * Minimal RPC reachability probe. Hits two of the simplest possible endpoints
 * (eth_chainId, eth_blockNumber) so any failure points to connectivity or
 * chain mismatch — not contract/ABI problems.
 */
export function useRpcHealth() {
  return useQuery({
    queryKey: ["rpcHealth"],
    queryFn: async () => {
      try {
        const [chainId, blockNumber] = await Promise.all([
          publicClient.getChainId(),
          publicClient.getBlockNumber(),
        ]);
        return { chainId, blockNumber };
      } catch (e) {
        console.error("[useRpcHealth] failed", e);
        throw e;
      }
    },
    // /me 진단 패널 전용. 방문 시 1회로 충분 — 20s polling은 upstream을
    // 불필요하게 때려서 tx 중 rate-limit 유발했음.
    staleTime: 1000 * 60,
    refetchInterval: false,
    retry: 1,
  });
}
