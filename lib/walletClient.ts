"use client";

import { createWalletClient, custom, type WalletClient } from "viem";
import { stableNetChain } from "./chain";
import { getEthereumProvider, getProviderByRdns } from "./ethereum";

// Must match STORAGE_RDNS in context/WalletContext.tsx
const STORAGE_RDNS = "stablefi_wallet_rdns";

/**
 * Build a viem walletClient on demand from the EIP-1193 provider the user
 * actually connected with — NOT whichever extension won the `window.ethereum`
 * race.
 *
 * Why this matters: with multiple wallets installed (e.g. MetaMask + Rabby),
 * `window.ethereum` is whoever got there first. If the user picked Rabby in
 * our WalletPickerModal but MetaMask won window.ethereum, sending the tx
 * through the "global" provider routes it to MetaMask — which is on a
 * different chain than the Rabby the user actually connected with. The
 * wallet then rejects with "current chain (id: 612055) does not match target
 * chain (id: 8283)".
 *
 * Resolution order:
 *   1) explicit `provider` argument (caller already has a ref — trust it)
 *   2) EIP-6963 provider matching the rdns saved by WalletContext on connect
 *   3) getEthereumProvider() as a last resort
 *
 * We intentionally do NOT cache — if the user switches account/chain we want
 * the next tx to re-read current state.
 */
export function getWalletClient(provider?: any): WalletClient {
  if (typeof window === "undefined") {
    throw new Error("브라우저 환경에서만 사용할 수 있어요");
  }

  let resolved = provider ?? null;

  if (!resolved) {
    const savedRdns = localStorage.getItem(STORAGE_RDNS);
    if (savedRdns) {
      const detail = getProviderByRdns(savedRdns);
      if (detail) resolved = detail.provider;
    }
  }

  if (!resolved) resolved = getEthereumProvider();

  if (!resolved) {
    throw new Error("지갑을 찾을 수 없어요. MetaMask를 설치해주세요.");
  }

  return createWalletClient({
    chain: stableNetChain,
    transport: custom(resolved),
  });
}
