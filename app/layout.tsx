import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import { Navbar } from "@/components/layout/Navbar";
import { NetworkBanner } from "@/components/layout/NetworkBanner";
import { BottomNav } from "@/components/layout/BottomNav";
import { WalletProvider } from "@/context/WalletContext";
import { ToastProvider } from "@/components/ui/Toast";
import { QueryProvider } from "@/components/providers/QueryProvider";

export const metadata: Metadata = {
  title: "StableFi",
  description: "토큰을 쉽게 바꾸고, 맡겨두면 수익이 쌓이는 서비스",
  icons: {
    icon: [
      {
        url:
          // Inline SVG favicon that matches the header logo (toss-blue square + white "S")
          "data:image/svg+xml;utf8," +
          encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#3182F6"/><text x="50%" y="56%" text-anchor="middle" dominant-baseline="middle" font-family="Pretendard, sans-serif" font-weight="900" font-size="40" fill="white" letter-spacing="-2">S</text></svg>`,
          ),
        type: "image/svg+xml",
      },
    ],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <body>
        <QueryProvider>
          <ToastProvider>
            <WalletProvider>
              <Navbar />
              <NetworkBanner />
              <main className="mx-auto max-w-[480px] px-4 pt-3 pb-[calc(4.5rem+env(safe-area-inset-bottom))]">
                {children}
              </main>
              <BottomNav />
            </WalletProvider>
          </ToastProvider>
        </QueryProvider>
        {/* Vercel Analytics — 프로덕션 배포에서만 자동 수집. 로컬/프리뷰에서는
            no-op이라 개발 성능에 영향 없음. */}
        <Analytics />
      </body>
    </html>
  );
}
