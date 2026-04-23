import { createPublicClient, http, type PublicClient } from "viem";
import { stableNetChain } from "./chain";

// Read-only viem client — safe to call from both server and browser.
// We create a single shared instance per module import.
let _client: PublicClient | null = null;

/**
 * Browser must go through our same-origin proxy (/api/rpc) because the
 * StableNet RPC doesn't set CORS headers for arbitrary origins.
 * On the server we can hit the upstream directly.
 */
function rpcUrl(): string {
  if (typeof window !== "undefined") return "/api/rpc";
  return stableNetChain.rpcUrls.default.http[0];
}

export function getPublicClient(): PublicClient {
  if (_client) return _client;
  _client = createPublicClient({
    chain: stableNetChain,
    transport: http(rpcUrl(), {
      // JSON-RPC request batching is safe (same endpoint, many calls).
      batch: { batchSize: 256, wait: 16 },
      // Upstream public RPC is rate-limited under burst load; bumped from
      // 2/300ms to 4/500ms (viem uses exponential backoff internally) so
      // transient 429s don't surface as "too many errors" to the user.
      retryCount: 4,
      retryDelay: 500,
    }),
    // IMPORTANT: Do NOT enable `batch: { multicall: true }` until we confirm
    // Multicall3 (0xca11bde05977b3631167028862be2a173976ca11) is deployed on
    // StableNet — otherwise every readContract fails.
  });
  return _client;
}

export const publicClient = getPublicClient();
