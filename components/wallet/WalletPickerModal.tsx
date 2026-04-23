"use client";

import { useEffect, useState } from "react";
import { X, Wallet, ChevronRight, Loader2 } from "lucide-react";
import {
  listEthereumProviders,
  refreshProviderDiscovery,
  type EIP6963ProviderDetail,
} from "@/lib/ethereum";
import { useWallet } from "@/context/WalletContext";
import { cn } from "@/lib/utils";

interface WalletPickerModalProps {
  onClose: () => void;
}

export function WalletPickerModal({ onClose }: WalletPickerModalProps) {
  const { connect, isConnecting } = useWallet();
  const [wallets, setWallets] = useState<EIP6963ProviderDetail[]>([]);
  const [pendingRdns, setPendingRdns] = useState<string | null>(null);

  // Re-probe on mount — covers wallets that announce late (right after this
  // modal opens). We also poll once more after 200ms for slow injectors.
  useEffect(() => {
    refreshProviderDiscovery();
    setWallets(listEthereumProviders());
    const t = setTimeout(() => {
      refreshProviderDiscovery();
      setWallets(listEthereumProviders());
    }, 200);
    return () => clearTimeout(t);
  }, []);

  const handlePick = async (detail: EIP6963ProviderDetail) => {
    setPendingRdns(detail.info.rdns);
    try {
      await connect(detail);
      onClose();
    } finally {
      setPendingRdns(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-md"
        onClick={onClose}
      />

      <div className="relative w-full max-w-sm bg-white mx-0 sm:mx-4 rounded-t-toss-lg sm:rounded-toss-lg overflow-hidden max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 shrink-0">
          <div>
            <h3 className="text-[16px] font-bold text-neutral-900">
              지갑 선택
            </h3>
            <p className="text-[11px] text-neutral-400 mt-0.5">
              연결할 지갑을 골라주세요
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-neutral-50 text-neutral-400 hover:text-neutral-700 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 pb-5">
          {wallets.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <div className="w-14 h-14 rounded-full bg-neutral-50 flex items-center justify-center mb-3">
                <Wallet size={24} className="text-neutral-300" />
              </div>
              <p className="text-[14px] font-bold text-neutral-900 mb-1">
                감지된 지갑이 없어요
              </p>
              <p className="text-[12px] text-neutral-400 leading-relaxed">
                MetaMask, Rabby, Phantom 등<br />
                지갑 확장 프로그램을 먼저 설치해주세요
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {wallets.map((w) => {
                const isPending = pendingRdns === w.info.rdns;
                const disabled = isConnecting && !isPending;
                return (
                  <button
                    key={w.info.uuid}
                    onClick={() => handlePick(w)}
                    disabled={disabled}
                    className={cn(
                      "w-full flex items-center gap-3 p-3 rounded-toss bg-neutral-50 hover:bg-neutral-100 press text-left transition-colors",
                      disabled && "opacity-50 cursor-not-allowed",
                    )}
                  >
                    <span className="w-10 h-10 rounded-xl bg-white flex items-center justify-center overflow-hidden shrink-0">
                      {w.info.icon ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={w.info.icon}
                          alt={w.info.name}
                          className="w-7 h-7 object-contain"
                        />
                      ) : (
                        <Wallet size={18} className="text-neutral-400" />
                      )}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-[14px] font-bold text-neutral-900 truncate">
                        {w.info.name}
                      </p>
                      <p className="text-[11px] text-neutral-400 truncate">
                        {w.info.rdns}
                      </p>
                    </div>
                    {isPending ? (
                      <Loader2
                        size={16}
                        className="text-toss-500 animate-spin shrink-0"
                      />
                    ) : (
                      <ChevronRight
                        size={16}
                        className="text-neutral-300 shrink-0"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {wallets.length > 0 && (
            <p className="mt-3 text-[11px] text-neutral-400 text-center leading-relaxed">
              지갑을 선택하면 계정 접근 권한을 요청해요
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
