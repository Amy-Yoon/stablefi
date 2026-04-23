import { defineChain } from "viem";

// ── StableNet Testnet ─────────────────────────────────────────────────────────
export const STABLENET_TESTNET = {
  id: 8283,
  name: "StableNet Testnet",
  rpcUrl: "https://api.test.stablenet.network",
  explorer: "https://explorer.stablenet.network",
  nativeCurrency: {
    name: "KRW",
    symbol: "KRW",
    decimals: 18,
  },
} as const;

// viem-compatible chain object (for publicClient / walletClient)
export const stableNetChain = defineChain({
  id: STABLENET_TESTNET.id,
  name: STABLENET_TESTNET.name,
  nativeCurrency: {
    name: STABLENET_TESTNET.nativeCurrency.name,
    symbol: STABLENET_TESTNET.nativeCurrency.symbol,
    decimals: STABLENET_TESTNET.nativeCurrency.decimals,
  },
  rpcUrls: {
    default: { http: [STABLENET_TESTNET.rpcUrl] },
    public:  { http: [STABLENET_TESTNET.rpcUrl] },
  },
  blockExplorers: {
    default: { name: "StableNet Explorer", url: STABLENET_TESTNET.explorer },
  },
  testnet: true,
});

// ── Deployed contract addresses ───────────────────────────────────────────────
export const CONTRACTS = {
  v3Factory:         "0xa0f51De7c6267fd10b168d941CB06093E76785D7" as `0x${string}`,
  v3Router:          "0x659BC8F37fb6EC52289B3c44cf6Fa6764ad113dF" as `0x${string}`,
  v3PositionManager: "0xAA52Bd6b11944343523dBC68C2B5f602D33A6e72" as `0x${string}`,
  v2Factory:         "0xec1c0fb2ceaa7349b381e5bdd574f6369b4129ce" as `0x${string}`,
  v2Router:          "0xe56c3f0375ec5644509715c42aa8764d4c857d01" as `0x${string}`,
} as const;

// ── Pool registry ─────────────────────────────────────────────────────────────
// Metadata-light: address + version only. token0/token1/reserves/prices are
// always resolved on-chain via hooks.
export type PoolVersion = "v2" | "v3";

export interface PoolRef {
  address: `0x${string}`;
  version: PoolVersion;
  /** Human label for UX only — real token symbols come from chain reads */
  label?: string;
}

export const KNOWN_POOLS: PoolRef[] = [
  // V3
  { address: "0x2DaA076d55b36Bb44CFa353aBEff14f8e259527f", version: "v3", label: "TokenA-TokenB" },
  { address: "0x1A44B490722F2a8B9BD42e99b9975447b3fe766b", version: "v3", label: "TokenA-WKRC" },
  { address: "0x6dca1605E2ac6Fd81B20eC3a297BdB9cABdF97F2", version: "v3", label: "TokenB-WKRC" },
  // V2
  { address: "0x98fb3369318A878fe660cF60908ba1EC48E62bb3", version: "v2", label: "TokenA-TokenB" },
  { address: "0x3E61F3f0234905492B6345c0Dab62e0e7772705e", version: "v2", label: "TokenA-WKRC" },
  { address: "0x5fB05975Ee104dC3A5483761729Fc68eA764f589", version: "v2", label: "TokenB-WKRC" },
];

// Convenience — first entry is the default "target" pool used by home/swap.
export const TARGET_POOL = KNOWN_POOLS[0].address;

// ── Tokens ────────────────────────────────────────────────────────────────────
export interface Token {
  address: `0x${string}`;
  symbol: string;
  name: string;
  decimals: number;
  logoUrl?: string;
}

// Token metadata is resolved from chain at runtime (symbol/name/decimals).
// This list is purely a hint for logos / display names until we have a registry.
export const TOKEN_HINTS: Record<string, { logoUrl?: string; displayName?: string }> = {
  // keyed by lowercased address
};

// Empty until resolved from chain — components should read via hooks.
export const TOKENS: Token[] = [];

// Default display unit for all KRW-equivalent values.
// WKRC is the wrapped KRW token — primary reference currency in UI.
export const REFERENCE_SYMBOL = "WKRC";
