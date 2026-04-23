"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { STABLENET_TESTNET } from "@/lib/chain";
import {
  getEthereumProvider,
  getProviderByRdns,
  refreshProviderDiscovery,
  type EIP6963ProviderDetail,
} from "@/lib/ethereum";
import { useToast } from "@/components/ui/Toast";
import { WalletPickerModal } from "@/components/wallet/WalletPickerModal";

interface WalletState {
  address: string | null;
  chainId: number | null;
  isConnected: boolean;
  isConnecting: boolean;
  /** Human-readable name of the currently connected wallet (e.g. "MetaMask"). */
  walletName: string | null;
  /**
   * Connect using a specific EIP-6963 provider. If detail is omitted we fall
   * back to the auto-picked provider (used for session restore + single-wallet
   * users). The picker modal always passes a detail explicitly.
   */
  connect: (detail?: EIP6963ProviderDetail) => Promise<void>;
  /** Open the wallet picker modal so the user can choose which wallet to use. */
  openPicker: () => void;
  disconnect: () => void;
  switchToStableNet: () => Promise<void>;
  isWrongNetwork: boolean;
}

const STORAGE_ADDRESS = "stablefi_wallet";
const STORAGE_RDNS = "stablefi_wallet_rdns";
const STORAGE_NAME = "stablefi_wallet_name";

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [walletName, setWalletName] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const { toast } = useToast();

  const openPicker = useCallback(() => setPickerOpen(true), []);
  const closePicker = useCallback(() => setPickerOpen(false), []);

  // The active EIP-1193 provider (the specific wallet we're using — not
  // necessarily window.ethereum). Tracked in a ref so listeners can be
  // attached/detached against the same instance.
  const providerRef = useRef<any | null>(null);

  const isConnected = !!address;
  const isWrongNetwork = isConnected && chainId !== STABLENET_TESTNET.id;

  const disconnect = useCallback(() => {
    setAddress(null);
    setChainId(null);
    setWalletName(null);
    providerRef.current = null;
    localStorage.removeItem(STORAGE_ADDRESS);
    localStorage.removeItem(STORAGE_RDNS);
    localStorage.removeItem(STORAGE_NAME);
  }, []);

  // Restore session from localStorage — prefer the previously-used wallet
  // (by rdns) so a user who connected with Rabby doesn't silently get MetaMask
  // back on refresh.
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_ADDRESS);
    if (!saved) return;
    (async () => {
      const savedRdns = localStorage.getItem(STORAGE_RDNS);

      // Give late-announcing wallets a brief window, then resolve.
      refreshProviderDiscovery();
      await new Promise((r) => setTimeout(r, 120));

      let provider: any | null = null;
      let name: string | null = localStorage.getItem(STORAGE_NAME);
      if (savedRdns) {
        const detail = getProviderByRdns(savedRdns);
        if (detail) {
          provider = detail.provider;
          name = detail.info.name;
        }
      }
      if (!provider) provider = getEthereumProvider();
      if (!provider) return;

      providerRef.current = provider;
      try {
        const accounts: string[] = await provider.request({
          method: "eth_accounts",
        });
        if (accounts[0]) {
          setAddress(accounts[0]);
          setWalletName(name);
          const hex: string = await provider.request({ method: "eth_chainId" });
          setChainId(parseInt(hex, 16));
        } else {
          disconnect();
        }
      } catch {
        disconnect();
      }
    })();
  }, [disconnect]);

  // Listen for account / chain / disconnect events on the ACTIVE provider.
  // Re-attach whenever providerRef changes (after connect).
  useEffect(() => {
    const provider = providerRef.current;
    if (!provider?.on) return;
    const onAccounts = (accounts: string[]) => {
      if (accounts[0]) setAddress(accounts[0]);
      else disconnect();
    };
    const onChain = (hex: string) => setChainId(parseInt(hex, 16));
    const onDisconnect = () => disconnect();
    provider.on("accountsChanged", onAccounts);
    provider.on("chainChanged", onChain);
    provider.on("disconnect", onDisconnect);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("chainChanged", onChain);
      provider.removeListener?.("disconnect", onDisconnect);
    };
  }, [disconnect, address]);

  // Re-verify when the tab regains focus — covers the case where the user
  // revoked site permission in another tab without triggering an event here.
  useEffect(() => {
    const recheck = async () => {
      if (document.hidden) return;
      if (!localStorage.getItem(STORAGE_ADDRESS)) return;
      const provider = providerRef.current ?? getEthereumProvider();
      if (!provider) return;
      try {
        const accounts: string[] = await provider.request({
          method: "eth_accounts",
        });
        if (!accounts[0]) disconnect();
      } catch {
        disconnect();
      }
    };
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("focus", recheck);
    return () => {
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener("focus", recheck);
    };
  }, [disconnect]);

  const connect = useCallback(
    async (detail?: EIP6963ProviderDetail) => {
      setIsConnecting(true);
      try {
        let provider: any | null = null;
        let name: string | null = null;
        let rdns: string | null = null;
        if (detail) {
          provider = detail.provider;
          name = detail.info.name;
          rdns = detail.info.rdns;
        } else {
          // Fallback for callers that didn't pick a specific wallet — happens
          // when only one wallet is installed (picker auto-resolves) or for
          // legacy code paths.
          refreshProviderDiscovery();
          await new Promise((r) => setTimeout(r, 80));
          provider = getEthereumProvider();
        }

        if (!provider) {
          toast(
            "지갑을 찾을 수 없어요. 지갑 확장을 설치하고 다시 시도해주세요",
            "error",
          );
          return;
        }
        providerRef.current = provider;

        const accounts: string[] = await provider.request({
          method: "eth_requestAccounts",
        });
        if (!accounts[0]) {
          toast("지갑 계정을 선택해주세요", "error");
          return;
        }
        const hexChain: string = await provider.request({
          method: "eth_chainId",
        });
        setAddress(accounts[0]);
        setChainId(parseInt(hexChain, 16));
        setWalletName(name);

        localStorage.setItem(STORAGE_ADDRESS, accounts[0]);
        if (rdns) localStorage.setItem(STORAGE_RDNS, rdns);
        else localStorage.removeItem(STORAGE_RDNS);
        if (name) localStorage.setItem(STORAGE_NAME, name);
        else localStorage.removeItem(STORAGE_NAME);
      } catch (e: any) {
        console.error("connect failed", e);
        const msg: string = e?.shortMessage ?? e?.message ?? String(e);
        const nestedMsg: string = e?.cause?.message ?? "";
        const hay = `${msg} ${nestedMsg}`;
        const code = e?.code;
        if (code === 4001 || /User rejected|denied/i.test(hay)) {
          toast("지갑 연결 요청을 취소했어요", "info");
        } else if (
          code === -32002 ||
          /Already processing/i.test(hay) ||
          /Requested resource not available/i.test(hay)
        ) {
          toast(
            "지갑이 이미 요청을 처리 중이에요. 지갑 팝업을 확인해주세요",
            "info",
          );
        } else if (/Cannot set property ethereum/i.test(hay)) {
          toast(
            "다른 지갑 확장과 충돌이 있어요. 연결하려는 지갑 하나만 남기고 비활성화해주세요",
            "error",
          );
        } else if (
          /defaultChain/i.test(hay) ||
          /Cannot destructure property/i.test(hay)
        ) {
          // Known issue with some wallet extensions (Phantom, OKX, Coinbase
          // smart wallet, ...) where their internal state isn't initialized
          // for an unfamiliar chain. They throw a viem destructuring error
          // before the account prompt even appears.
          toast(
            `${detail?.info.name ?? "이 지갑"}이(가) StableNet 네트워크를 인식하지 못해요. 지갑에서 StableNet Testnet을 먼저 추가하거나 다른 지갑으로 연결해주세요`,
            "error",
          );
        } else {
          toast(`지갑 연결 실패: ${msg}`, "error");
        }
      } finally {
        setIsConnecting(false);
      }
    },
    [toast],
  );

  const switchToStableNet = useCallback(async () => {
    const provider = providerRef.current ?? getEthereumProvider();
    if (!provider) {
      toast("지갑이 연결되어 있지 않아요", "error");
      return;
    }
    const hexId = "0x" + STABLENET_TESTNET.id.toString(16);

    // Strategy: try switch first (fast path when chain already added).
    // If it fails for ANY reason (not just 4902), fall back to add+switch.
    // Rabby and some other wallets don't reliably return 4902 when the
    // chain isn't added, so keying off the code alone misses them.
    let switchErr: any = null;
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: hexId }],
      });
      return;
    } catch (err: any) {
      switchErr = err;
      // User explicitly rejected — don't silently retry with an add prompt.
      if (err?.code === 4001 || /User rejected|denied/i.test(err?.message ?? "")) {
        toast("네트워크 전환 요청을 취소했어요", "info");
        return;
      }
    }

    try {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hexId,
            chainName: STABLENET_TESTNET.name,
            rpcUrls: [STABLENET_TESTNET.rpcUrl],
            nativeCurrency: STABLENET_TESTNET.nativeCurrency,
            blockExplorerUrls: [STABLENET_TESTNET.explorer],
          },
        ],
      });
      // Most wallets auto-switch after add. Nudge once more if not.
      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: hexId }],
        });
      } catch {
        /* best-effort */
      }
    } catch (addErr: any) {
      console.error("Failed to add chain", { switchErr, addErr });
      const msg: string =
        addErr?.shortMessage ??
        addErr?.message ??
        addErr?.cause?.message ??
        String(addErr);
      const code = addErr?.code;
      if (code === 4001 || /User rejected|denied/i.test(msg)) {
        toast("네트워크 추가 요청을 취소했어요", "info");
      } else if (/already/i.test(msg) || /exists/i.test(msg)) {
        // Chain is already added but switch is failing — usually wallet
        // locked or another request is pending. Ask user to act in-wallet.
        toast(
          "지갑에서 직접 StableNet Testnet으로 전환해주세요 (지갑 잠김 또는 대기 중인 요청 확인)",
          "error",
        );
      } else {
        toast(`네트워크 추가 실패: ${msg}`, "error");
      }
    }
  }, [toast]);

  return (
    <WalletContext.Provider
      value={{
        address,
        chainId,
        isConnected,
        isConnecting,
        walletName,
        connect,
        openPicker,
        disconnect,
        switchToStableNet,
        isWrongNetwork,
      }}
    >
      {children}
      {pickerOpen && <WalletPickerModal onClose={closePicker} />}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside WalletProvider");
  return ctx;
}
