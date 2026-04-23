"use client";

import { useQuery } from "@tanstack/react-query";
import type { Abi } from "viem";
import { publicClient } from "@/lib/client";
import V3PoolJson from "@/lib/abi/V3Pool.json";
import V2PairJson from "@/lib/abi/V2Pair.json";
import ERC20Json from "@/lib/abi/ERC20.json";
import { TOKEN_HINTS, type Token, type PoolRef, type PoolVersion } from "@/lib/chain";

const V3Pool = V3PoolJson as Abi;
const V2Pair = V2PairJson as Abi;
const ERC20  = ERC20Json  as Abi;

// ── Unified pool state ────────────────────────────────────────────────────────
// V2 and V3 share the common fields; V3-only fields are optional.
export interface PoolState {
  address: `0x${string}`;
  version: PoolVersion;
  token0: Token;
  token1: Token;
  /** Swap fee in basis points × 100. V2 = 3000 (0.3%) by protocol design. */
  fee: number;

  /** Human units price of token1 per 1 token0 */
  price1Per0: number;
  /** Inverse */
  price0Per1: number;

  // ── V2-only (reserves) ──────────────────────────────────────────────────────
  reserve0?: bigint;
  reserve1?: bigint;

  // ── V3-only ─────────────────────────────────────────────────────────────────
  tickSpacing?: number;
  liquidity?: bigint;
  sqrtPriceX96?: bigint;
  tick?: number;
}

const DEFAULT_LOGO: Record<string, string> = {
  WKRC: "🇰🇷", WETH: "⟠", WBTC: "₿", USDT: "💵", USDC: "💵",
};

// ── V3 reader ─────────────────────────────────────────────────────────────────
export async function fetchV3Pool(address: `0x${string}`): Promise<PoolState> {
  const [token0Addr, token1Addr, fee, tickSpacing, liquidity, slot0] = await Promise.all([
    publicClient.readContract({ address, abi: V3Pool, functionName: "token0" })      as Promise<`0x${string}`>,
    publicClient.readContract({ address, abi: V3Pool, functionName: "token1" })      as Promise<`0x${string}`>,
    publicClient.readContract({ address, abi: V3Pool, functionName: "fee" })         as Promise<number>,
    publicClient.readContract({ address, abi: V3Pool, functionName: "tickSpacing" }) as Promise<number>,
    publicClient.readContract({ address, abi: V3Pool, functionName: "liquidity" })   as Promise<bigint>,
    publicClient.readContract({ address, abi: V3Pool, functionName: "slot0" })       as Promise<readonly [bigint, number, number, number, number, number, boolean]>,
  ]);

  const [t0, t1] = await Promise.all([tokenMeta(token0Addr), tokenMeta(token1Addr)]);

  const sqrtPriceX96 = slot0[0];
  const tick         = slot0[1];

  // price(token1 per token0) = (sqrtPriceX96 / 2^96)^2, then decimal-adjusted.
  const Q96 = 2 ** 96;
  const sqrtP = Number(sqrtPriceX96) / Q96;
  const raw   = sqrtP * sqrtP;
  const decimalAdj = 10 ** (t0.decimals - t1.decimals);
  const price1Per0 = raw * decimalAdj;
  const price0Per1 = price1Per0 === 0 ? 0 : 1 / price1Per0;

  return {
    address,
    version: "v3",
    token0: t0,
    token1: t1,
    fee: Number(fee),
    tickSpacing: Number(tickSpacing),
    liquidity,
    sqrtPriceX96,
    tick: Number(tick),
    price1Per0,
    price0Per1,
  };
}

// ── V2 reader ─────────────────────────────────────────────────────────────────
export async function fetchV2Pool(address: `0x${string}`): Promise<PoolState> {
  const [token0Addr, token1Addr, reserves] = await Promise.all([
    publicClient.readContract({ address, abi: V2Pair, functionName: "token0" }) as Promise<`0x${string}`>,
    publicClient.readContract({ address, abi: V2Pair, functionName: "token1" }) as Promise<`0x${string}`>,
    publicClient.readContract({ address, abi: V2Pair, functionName: "getReserves" }) as Promise<readonly [bigint, bigint, number]>,
  ]);

  const [t0, t1] = await Promise.all([tokenMeta(token0Addr), tokenMeta(token1Addr)]);

  const reserve0 = reserves[0];
  const reserve1 = reserves[1];

  // Price = (reserve1/10^d1) / (reserve0/10^d0)
  //       = (reserve1 * 10^d0) / (reserve0 * 10^d1)
  const r0Human = Number(reserve0) / 10 ** t0.decimals;
  const r1Human = Number(reserve1) / 10 ** t1.decimals;
  const price1Per0 = r0Human === 0 ? 0 : r1Human / r0Human;
  const price0Per1 = price1Per0 === 0 ? 0 : 1 / price1Per0;

  return {
    address,
    version: "v2",
    token0: t0,
    token1: t1,
    fee: 3000, // V2 protocol-level 0.3%
    reserve0,
    reserve1,
    price1Per0,
    price0Per1,
  };
}

// ── Token metadata ────────────────────────────────────────────────────────────
async function tokenMeta(address: `0x${string}`): Promise<Token> {
  const [symbol, name, decimals] = await Promise.all([
    publicClient.readContract({ address, abi: ERC20, functionName: "symbol" })   as Promise<string>,
    publicClient.readContract({ address, abi: ERC20, functionName: "name" })     as Promise<string>,
    publicClient.readContract({ address, abi: ERC20, functionName: "decimals" }) as Promise<number>,
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

// ── Public hook ───────────────────────────────────────────────────────────────
export function usePool(ref?: PoolRef) {
  return useQuery({
    queryKey: ["pool", ref?.address.toLowerCase(), ref?.version],
    queryFn: async () => {
      try {
        if (!ref) throw new Error("no pool ref");
        return ref.version === "v3"
          ? await fetchV3Pool(ref.address)
          : await fetchV2Pool(ref.address);
      } catch (e) {
        console.error("[usePool] fetch failed", { ref, error: e });
        throw e;
      }
    },
    enabled: !!ref,
    // Bumped from 15s/30s to avoid hammering public RPC when multiple
    // pools are mounted in parallel (6 pools × 30s = 12 requests/min,
    // each a multicall read). Users manually refresh on demand; mutation
    // side-effects invalidate this key directly.
    staleTime: 1000 * 60 * 2,
    refetchInterval: 1000 * 60 * 5,
    retry: 1,
  });
}

/**
 * Convert an amount of `token` (either token0 or token1 of `pool`) to its
 * equivalent amount of the *other* token at the current pool price.
 */
export function convertAcrossPool(
  pool: PoolState,
  from: `0x${string}`,
  amount: number,
): { to: Token; amount: number } {
  const isFrom0 = from.toLowerCase() === pool.token0.address.toLowerCase();
  if (isFrom0) return { to: pool.token1, amount: amount * pool.price1Per0 };
  return { to: pool.token0, amount: amount * pool.price0Per1 };
}
