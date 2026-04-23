"use client";

import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useWallet } from "@/context/WalletContext";
import { STABLENET_TESTNET } from "@/lib/chain";

// Global sticky banner that nags the user to switch networks from ANY page.
// Previously this action was buried inside /me — which is unacceptable when
// a chain mismatch blocks every tx (swap, deposit, withdraw). Mounted once in
// RootLayout directly below <Navbar /> and sits on top of the page content.
//
// Only renders when a wallet is connected AND on the wrong chain — for
// disconnected users the PrimaryButton inside each page already handles the
// "연결해주세요" case, so showing this would be noise.

export function NetworkBanner() {
  const { isConnected, isWrongNetwork, chainId, switchToStableNet } = useWallet();
  const [switching, setSwitching] = useState(false);

  if (!isConnected || !isWrongNetwork) return null;

  const onSwitch = async () => {
    setSwitching(true);
    try {
      await switchToStableNet();
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="sticky top-14 z-30 bg-amber-50 border-y border-amber-100">
      <div className="mx-auto max-w-[480px] px-4 py-2.5 flex items-center gap-2">
        <AlertTriangle size={16} className="text-amber-600 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-bold text-amber-900 leading-tight">
            {STABLENET_TESTNET.name}으로 전환해주세요
          </p>
          <p className="text-[11px] text-amber-700/80 tabular-nums leading-tight mt-0.5">
            현재 네트워크 ID {chainId ?? "?"} · 필요 ID {STABLENET_TESTNET.id}
          </p>
        </div>
        <button
          onClick={onSwitch}
          disabled={switching}
          className="shrink-0 h-9 px-3 rounded-lg bg-amber-500 hover:bg-amber-600 disabled:opacity-50 press text-white text-[13px] font-bold flex items-center gap-1.5"
        >
          {switching ? (
            <>
              <Loader2 size={12} className="animate-spin" />
              전환 중
            </>
          ) : (
            "전환하기"
          )}
        </button>
      </div>
    </div>
  );
}
