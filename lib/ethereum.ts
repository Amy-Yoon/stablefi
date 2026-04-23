"use client";

/**
 * Robust EIP-1193 provider discovery.
 *
 * Why this exists: when a user has multiple wallet extensions (e.g. Phantom +
 * MetaMask, or Rabby + Coinbase), they race to set `window.ethereum`. Whichever
 * loses loses silently — we'd see only one wallet, and not necessarily the one
 * the user wants. The browser console will show a line like:
 *
 *   "MetaMask encountered an error setting the global Ethereum provider —
 *    Cannot set property ethereum of #<Window> which has only a getter"
 *
 * EIP-6963 solves this: every wallet announces itself via events. We collect
 * all announcements, then pick by preference (MetaMask first). We fall back to
 * `window.ethereum.providers[]` (old MetaMask convention) and finally
 * `window.ethereum` itself.
 */

export interface EIP6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string; // e.g. "io.metamask", "app.phantom", "com.coinbase.wallet"
}

export interface EIP6963ProviderDetail {
  info: EIP6963ProviderInfo;
  provider: any; // EIP-1193 provider
}

const discovered: EIP6963ProviderDetail[] = [];
let listenerAttached = false;

function attachAnnounceListener() {
  if (typeof window === "undefined" || listenerAttached) return;
  listenerAttached = true;
  window.addEventListener("eip6963:announceProvider", (event: any) => {
    const detail = event.detail as EIP6963ProviderDetail;
    if (!detail?.info?.uuid) return;
    if (discovered.find((p) => p.info.uuid === detail.info.uuid)) return;
    discovered.push(detail);
  });
}

/** Re-poll wallets. Wallets respond synchronously in the same tick. */
export function refreshProviderDiscovery() {
  if (typeof window === "undefined") return;
  attachAnnounceListener();
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

// Kick off discovery as soon as this module loads on the client.
if (typeof window !== "undefined") {
  refreshProviderDiscovery();
}

export function listEthereumProviders(): EIP6963ProviderDetail[] {
  return [...discovered];
}

/** Lookup a specific provider by its announced rdns (e.g. "io.metamask"). */
export function getProviderByRdns(rdns: string): EIP6963ProviderDetail | null {
  return discovered.find((p) => p.info.rdns === rdns) ?? null;
}

/** Lookup a specific provider by EIP-6963 uuid. */
export function getProviderByUuid(uuid: string): EIP6963ProviderDetail | null {
  return discovered.find((p) => p.info.uuid === uuid) ?? null;
}

/**
 * Return the best provider we can find.
 * Preference: MetaMask → any EIP-6963 wallet → legacy `window.ethereum.providers[]`
 * containing MetaMask → `window.ethereum`.
 */
export function getEthereumProvider(): any | null {
  if (typeof window === "undefined") return null;

  // 1) EIP-6963 — modern multi-wallet discovery
  const mm6963 = discovered.find((p) => p.info.rdns === "io.metamask");
  if (mm6963) return mm6963.provider;

  // 2) Legacy: some wallets stash all injected providers on window.ethereum.providers
  const eth = (window as any).ethereum;
  if (eth?.providers && Array.isArray(eth.providers)) {
    const mm = eth.providers.find((p: any) => p.isMetaMask);
    if (mm) return mm;
    if (eth.providers[0]) return eth.providers[0];
  }

  // 3) First non-MetaMask wallet from EIP-6963 (better than nothing)
  if (discovered[0]) return discovered[0].provider;

  // 4) Fallback: whatever won the `window.ethereum` race
  return eth ?? null;
}

/**
 * Give late-announcing wallets a short window, then return the best provider.
 * Useful at connect() time — guarantees MetaMask is found even if it announced
 * after our initial page load.
 */
export async function resolveEthereumProvider(
  { waitMs = 80 }: { waitMs?: number } = {},
): Promise<any | null> {
  refreshProviderDiscovery();
  await new Promise((r) => setTimeout(r, waitMs));
  return getEthereumProvider();
}
