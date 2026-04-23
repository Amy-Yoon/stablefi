"use client";

import { useQuery } from "@tanstack/react-query";
import type { Abi } from "viem";
import { publicClient } from "@/lib/client";
import ERC20Json from "@/lib/abi/ERC20.json";
import { TOKEN_HINTS, type Token } from "@/lib/chain";

const ERC20 = ERC20Json as Abi;

// Logos we fall back to when no hint is provided
const DEFAULT_LOGO: Record<string, string> = {
  WKRC: "🇰🇷",
  WETH: "⟠",
  WBTC: "₿",
  USDT: "💵",
  USDC: "💵",
};

async function fetchTokenMeta(address: `0x${string}`): Promise<Token> {
  const [symbol, name, decimals] = await Promise.all([
    publicClient.readContract({
      address, abi: ERC20, functionName: "symbol",
    }) as Promise<string>,
    publicClient.readContract({
      address, abi: ERC20, functionName: "name",
    }) as Promise<string>,
    publicClient.readContract({
      address, abi: ERC20, functionName: "decimals",
    }) as Promise<number>,
  ]);

  const hint = TOKEN_HINTS[address.toLowerCase()] ?? {};
  return {
    address,
    symbol,
    name: hint.displayName ?? name,
    decimals: Number(decimals),
    logoUrl: hint.logoUrl ?? DEFAULT_LOGO[symbol] ?? "🪙",
  };
}

export function useToken(address?: `0x${string}`) {
  return useQuery({
    queryKey: ["token", address?.toLowerCase()],
    queryFn: async () => {
      try {
        return await fetchTokenMeta(address!);
      } catch (e) {
        console.error("[useToken] meta fetch failed", { address, error: e });
        throw e;
      }
    },
    enabled: !!address,
    staleTime: 1000 * 60 * 60, // metadata rarely changes → 1h
    gcTime: 1000 * 60 * 60 * 24,
    retry: 1,
  });
}

export function useTokenBalance(
  token?: `0x${string}`,
  account?: `0x${string}`,
) {
  return useQuery({
    queryKey: ["tokenBalance", token?.toLowerCase(), account?.toLowerCase()],
    queryFn: async () => {
      try {
        return await publicClient.readContract({
          address: token!,
          abi: ERC20,
          functionName: "balanceOf",
          args: [account!],
        }) as bigint;
      } catch (e) {
        console.error("[useTokenBalance] failed", { token, account, error: e });
        throw e;
      }
    },
    enabled: !!token && !!account,
    // Swap page keeps multiple balances mounted; 30s polling stacks up fast
    // when tokens×users are considered. Bumped to 2min — mutations that
    // affect balance invalidate this key directly (see swap/approve flows).
    staleTime: 1000 * 60 * 2,
    refetchInterval: 1000 * 60 * 2,
    retry: 1,
  });
}
