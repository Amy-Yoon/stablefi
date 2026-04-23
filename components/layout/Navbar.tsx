"use client";

import Link from "next/link";
import { Logo } from "@/components/layout/Logo";
import { WalletButton } from "@/components/wallet/WalletButton";

// Header matches the bottom nav: a full-width white strip with its
// content center-constrained to the app column. This creates a clean
// "white header → gray body (cards) → white footer" sandwich that
// works identically on mobile and desktop.
//
// Right-aligned slot holds the WalletButton so connect / disconnect /
// wrong-network actions are reachable from every page without a trip to
// /me. The old "StableNet 테스트넷" vanity badge moved into a smaller
// "테스트넷" chip next to the button — full network status lives in the
// NetworkBanner below, no need to duplicate the chain name here.

export function Navbar() {
  return (
    <header className="sticky top-0 z-30 bg-white">
      <div className="mx-auto max-w-[480px] px-5 h-14 flex items-center gap-2">
        <Link href="/" className="flex items-center gap-1.5 shrink-0 press">
          <Logo size={24} />
          <span className="text-[16px] font-black text-neutral-900 tracking-tight">
            StableFi
          </span>
        </Link>

        <span className="ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 shrink-0">
          테스트넷
        </span>

        <div className="ml-auto shrink-0">
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
