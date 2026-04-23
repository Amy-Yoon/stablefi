"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, ArrowLeftRight, PiggyBank, User } from "lucide-react";
import { cn } from "@/lib/utils";

// Toss-style bottom tab bar:
// - White background, no borders/dividers
// - Active tab: Toss blue icon + bold label (color shift only — no pill)
// - Inactive: medium gray
// - 24px icons for generous tap targets

const ITEMS = [
  { label: "홈",      href: "/",      icon: Home,           match: (p: string) => p === "/" },
  { label: "바꾸기",  href: "/swap",  icon: ArrowLeftRight, match: (p: string) => p.startsWith("/swap") },
  { label: "모으기",  href: "/pools", icon: PiggyBank,      match: (p: string) => p.startsWith("/pools") },
  { label: "내 계정", href: "/me",    icon: User,           match: (p: string) => p.startsWith("/me") },
];

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-40 bg-white border-t border-neutral-50"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="flex mx-auto max-w-[480px]">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          const active = item.match(pathname);
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                className={cn(
                  "flex flex-col items-center justify-center gap-1 py-2 press",
                  active ? "text-toss-500" : "text-neutral-400",
                )}
              >
                <Icon size={24} strokeWidth={active ? 2.3 : 1.9} />
                <span className={cn(
                  "text-[11px]",
                  active ? "font-bold" : "font-medium",
                )}>
                  {item.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
