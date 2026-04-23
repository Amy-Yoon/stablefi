"use client";

import { Wallet, LogOut, ChevronDown, Repeat } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { useWallet } from "@/context/WalletContext";
import { shortenAddress } from "@/lib/utils";

export function WalletButton() {
  const {
    address,
    isConnected,
    isConnecting,
    walletName,
    openPicker,
    disconnect,
  } = useWallet();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // NOTE: wrong-network state is handled by <NetworkBanner /> globally —
  // we intentionally do NOT render a second switch button here. Even on a
  // wrong chain, the wallet is still "connected" from the user's POV, so
  // we keep the address + dropdown so logout / wallet-swap stay reachable.

  if (!isConnected) {
    return (
      <button
        onClick={openPicker}
        disabled={isConnecting}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-900 hover:bg-black text-white text-[13px] font-medium transition-colors disabled:opacity-40"
      >
        <Wallet size={13} />
        {isConnecting ? "연결 중..." : "지갑 연결"}
      </button>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-50 border border-gray-200 text-[13px] font-medium text-gray-700 hover:bg-gray-100 transition-colors"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
        {shortenAddress(address!)}
        <ChevronDown size={13} className={`text-gray-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-52 rounded-xl bg-white border border-gray-100 shadow-dropdown overflow-hidden z-50">
          <div className="px-3 py-2.5 border-b border-gray-100">
            <p className="text-[11px] text-gray-400 mb-0.5">
              {walletName ? `${walletName} 계정` : "내 계정"}
            </p>
            <p className="text-xs font-mono text-gray-700">{shortenAddress(address!)}</p>
          </div>
          <button
            onClick={() => {
              setOpen(false);
              disconnect();
              // Small delay so the dropdown animation can finish before the
              // picker modal slides up on top.
              setTimeout(() => openPicker(), 60);
            }}
            className="flex items-center gap-2 w-full px-3 py-2.5 text-[13px] text-gray-700 hover:bg-gray-50 transition-colors border-b border-gray-100"
          >
            <Repeat size={13} />
            다른 지갑으로 연결
          </button>
          <button
            onClick={() => { disconnect(); setOpen(false); }}
            className="flex items-center gap-2 w-full px-3 py-2.5 text-[13px] text-red-500 hover:bg-red-50 transition-colors"
          >
            <LogOut size={13} />
            로그아웃
          </button>
        </div>
      )}
    </div>
  );
}
