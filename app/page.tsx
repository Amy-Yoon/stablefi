"use client";

import Link from "next/link";
import {
  ArrowLeftRight, PiggyBank, ChevronRight, Eye, EyeOff,
  TrendingUp, Sparkles, QrCode, Send, ExternalLink, Rocket, Droplet,
} from "lucide-react";
import { formatUnits } from "viem";
import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useWallet } from "@/context/WalletContext";
import { usePoolsAggregate } from "@/hooks/usePoolsAggregate";
import { publicClient } from "@/lib/client";
import type { PoolState } from "@/hooks/usePool";
import { KNOWN_POOLS, type Token } from "@/lib/chain";
import { formatTokenAmount, cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/Skeleton";
import { Section } from "@/components/ui/Section";
import { PageHeader } from "@/components/ui/PageHeader";
import { PrimaryButton } from "@/components/ui/PrimaryButton";
import { ReceiveModal } from "@/components/account/ReceiveModal";
import { SendModal } from "@/components/account/SendModal";
import { RecentActivityWidget } from "@/components/activity/RecentActivityWidget";
import { useActivity } from "@/hooks/useActivity";
import ERC20Json from "@/lib/abi/ERC20.json";
import type { Abi } from "viem";

const ERC20 = ERC20Json as Abi;

export default function HomePage() {
  const { isConnected, openPicker, address } = useWallet();
  const { states, wkrcPrices, loading, myDepositedTotalWKRC, myEarnedTotalWKRC } =
    usePoolsAggregate(KNOWN_POOLS);

  const tokens = useMemo(() => dedupeTokens(states), [states]);

  const balanceQueries = useQueries({
    queries: tokens.map((t) => ({
      queryKey: ["tokenBalance", t.address.toLowerCase(), address?.toLowerCase()],
      queryFn: () =>
        publicClient.readContract({
          address: t.address,
          abi: ERC20,
          functionName: "balanceOf",
          args: [address!],
        }) as Promise<bigint>,
      enabled: !!address,
      // Home hero fans out to N balance reads per token; combined with
      // pools aggregate this dominated RPC load. 2min cadence + window
      // focus refresh (via QueryProvider) keeps values fresh enough.
      staleTime: 1000 * 60 * 2,
      refetchInterval: 1000 * 60 * 2,
      retry: 1,
    })),
  });

  const holdings = tokens.map((token, i) => {
    const raw = balanceQueries[i]?.data as bigint | undefined;
    const human = raw ? Number(formatUnits(raw, token.decimals)) : 0;
    const wkrcPrice = wkrcPrices[token.address.toLowerCase()];
    const wkrcValue = wkrcPrice !== undefined ? human * wkrcPrice : undefined;
    return { token, raw, human, wkrcPrice, wkrcValue };
  });

  const walletWKRC = holdings.reduce((sum, h) => sum + (h.wkrcValue ?? 0), 0);
  // V3 NFT positions (principal) + uncollected fees, via usePoolsAggregate.
  const defiWKRC = myDepositedTotalWKRC + myEarnedTotalWKRC;
  const totalWKRC = walletWKRC + defiWKRC;

  const hasAnyBalance = holdings.some((h) => h.human > 0);
  const balancesLoading = isConnected && balanceQueries.some((q) => q.isLoading);

  const [hidden, setHidden] = useState(false);
  const [showReceive, setShowReceive] = useState(false);
  const [showSend, setShowSend] = useState(false);

  // Unconnected state ───────────────────────────────────────────────────────
  if (!isConnected) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="안녕하세요 👋"
          desc="지갑을 연결하고 자산을 한눈에 확인해보세요"
        />

        <Section>
          <div className="rounded-toss-lg bg-white p-5">
            <PrimaryButton onClick={openPicker}>
              지갑 연결하기
            </PrimaryButton>
          </div>
        </Section>

        <Section title="이런 건 어때요?">
          <div className="flex flex-col gap-2">
            <PromoCard
              href="/swap"
              icon={<Sparkles size={20} className="text-toss-500" strokeWidth={2.4} />}
              iconBg="bg-toss-50"
              title="1초 교환"
              desc="원하는 토큰을 수수료 최저가로 바꿔요"
              badge="바꾸기"
            />
            <PromoCard
              href="/pools"
              icon={<TrendingUp size={20} className="text-gain-500" strokeWidth={2.4} />}
              iconBg="bg-gain-50"
              title="수수료 수익 받기"
              desc="토큰을 예치하고 스왑 수수료를 자동으로 받아보세요"
              badge="모으기"
            />
            <PromoCard
              href="https://faucet.stablenet.network/"
              external
              icon={<Droplet size={20} strokeWidth={2.4} style={{ color: "#D97706" }} />}
              iconBgStyle={{ backgroundColor: "#FEF3C7" }}
              title="StableNet Faucet"
              desc="가스비가 없다면 여기서 무료로 받아가세요"
              badge="외부 도구"
            />
            <PromoCard
              href="https://stablenet-pad-production.up.railway.app/"
              external
              icon={<Rocket size={20} className="text-violet-500" strokeWidth={2.4} />}
              iconBg="bg-violet-50"
              title="StableNet-Pad"
              desc="ERC20 토큰을 발행하고 풀까지 한 번에 만들어요"
              badge="외부 도구"
            />
          </div>
        </Section>
      </div>
    );
  }

  // Connected state ─────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="내 자산"
        desc="지갑과 모으기 예치금을 한눈에 봐요"
        action={
          <button
            onClick={() => setHidden((v) => !v)}
            aria-label={hidden ? "보이기" : "가리기"}
            className="p-1.5 text-neutral-400 hover:text-neutral-600 hover:bg-neutral-50 rounded-full transition-colors"
          >
            {hidden ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        }
      />

      {/* ── 자산 합계 — total + 지갑/예치 분리 + 퀵액션 ──────────────────────── */}
      <Section>
        <div className="rounded-toss-lg bg-white overflow-hidden">
          {/* Total balance */}
          <div className="px-5 pt-5 pb-4">
            {loading || balancesLoading ? (
              <Skeleton className="h-10 w-48 rounded-lg" />
            ) : (
              <div className="flex items-baseline gap-1.5">
                <p className="text-[34px] font-black text-neutral-900 tabular-nums leading-none tracking-tight">
                  {hidden ? "••••••" : Math.round(totalWKRC).toLocaleString("ko-KR")}
                </p>
                <p className="text-[17px] font-bold text-neutral-900">원</p>
              </div>
            )}
          </div>

          {/* Wallet / DeFi split — side-by-side mini-cards */}
          <div className="grid grid-cols-2 gap-2 px-3">
            <BalanceSplit
              label="지갑에 있어요"
              amountWKRC={walletWKRC}
              hidden={hidden}
              loading={balancesLoading}
            />
            <BalanceSplit
              label="모으기에 예치"
              amountWKRC={defiWKRC}
              hidden={hidden}
              muted
            />
          </div>

          {/* Quick actions — 4 primary wallet verbs */}
          <div className="grid grid-cols-4 gap-1 px-2 pt-3 pb-4">
            <QuickAction
              onClick={() => setShowReceive(true)}
              label="받기"
              icon={<QrCode size={22} strokeWidth={2.2} />}
            />
            <QuickAction
              onClick={() => setShowSend(true)}
              label="보내기"
              icon={<Send size={22} strokeWidth={2.2} />}
              disabled={!hasAnyBalance}
            />
            <QuickAction
              href="/swap"
              label="바꾸기"
              icon={<ArrowLeftRight size={22} strokeWidth={2.2} />}
            />
            <QuickAction
              href="/pools"
              label="모으기"
              icon={<PiggyBank size={22} strokeWidth={2.2} />}
            />
          </div>
        </div>
      </Section>

      {/* ── 내 토큰 (지갑 보유 전체 리스트) ───────────────────────────────── */}
      <Section title="내 토큰">
        {loading && tokens.length === 0 ? (
          <div className="bg-white rounded-toss-lg overflow-hidden">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        ) : tokens.length === 0 ? (
          <div className="p-6 rounded-toss-lg bg-white text-[13px] text-neutral-400 text-center">
            따라갈 수 있는 토큰이 아직 없어요
          </div>
        ) : (
          <div className="bg-white rounded-toss-lg overflow-hidden">
            {holdings.map((h) => (
              <HoldingRow key={h.token.address} holding={h} hidden={hidden} />
            ))}
          </div>
        )}
      </Section>

      {/* ── 최근 거래내역 — 5건 + 전체보기 링크 ─────────────────────────────
          "전체 보기" 버튼은 내역이 있을 때만 노출한다. 빈 상태에서 누르면
          똑같이 빈 /activity로 이동해 사용자에게 가치를 주지 못하므로. */}
      {address && (
        <RecentActivitySection address={address} />
      )}

      {/* ── 이런 건 어때요? — 탐색 (바꾸기 / 모으기 / Faucet / StableNet-Pad) ─── */}
      <Section title="이런 건 어때요?">
        <div className="flex flex-col gap-2">
          <PromoCard
            href="/swap"
            icon={<Sparkles size={20} className="text-toss-500" strokeWidth={2.4} />}
            iconBg="bg-toss-50"
            title="1초 교환"
            desc="원하는 토큰을 수수료 최저가로 바꿔요"
            badge="바꾸기"
          />
          <PromoCard
            href="/pools"
            icon={<TrendingUp size={20} className="text-gain-500" strokeWidth={2.4} />}
            iconBg="bg-gain-50"
            title="수수료 수익 받기"
            desc="토큰을 예치하고 스왑 수수료를 자동으로 받아보세요"
            badge="모으기"
          />
          <PromoCard
            href="https://faucet.stablenet.network/"
            external
            icon={<Droplet size={20} strokeWidth={2.4} style={{ color: "#D97706" }} />}
            iconBgStyle={{ backgroundColor: "#FEF3C7" }}
            title="StableNet Faucet"
            desc="가스비가 없다면 여기서 무료로 받아가세요"
            badge="외부 도구"
          />
          <PromoCard
            href="https://stablenet-pad-production.up.railway.app/"
            external
            icon={<Rocket size={20} className="text-violet-500" strokeWidth={2.4} />}
            iconBg="bg-violet-50"
            title="StableNet-Pad"
            desc="ERC20 토큰을 발행하고 풀까지 한 번에 만들어요"
            badge="외부 도구"
          />
        </div>
      </Section>

      {/* Modals */}
      {showReceive && address && (
        <ReceiveModal address={address} onClose={() => setShowReceive(false)} />
      )}
      {showSend && address && tokens.length > 0 && (
        <SendModal
          tokens={tokens}
          onClose={() => setShowSend(false)}
        />
      )}
    </div>
  );
}

// ── 최근 거래내역 섹션 ─────────────────────────────────────────────────
// 위젯과 같은 Query key를 공유해 별도 요청 없이 items 존재 여부를 알아낸다.
// 빈 상태에선 Section header의 "전체 보기" 링크도 함께 숨긴다.

function RecentActivitySection({ address }: { address: string }) {
  // 위젯과 동일한 useActivity 훅을 공유. 한 번의 fetch를 둘 다 재사용하고,
  // 이전처럼 같은 queryKey에 서로 다른 queryFn이 붙는 레이스가 없어짐.
  const { data } = useActivity(address, 20);
  const hasItems = (data?.items?.length ?? 0) > 0;
  return (
    <Section
      title="최근 거래내역"
      action={
        hasItems ? (
          <Link
            href="/activity"
            className="text-[12px] font-bold text-toss-500 hover:bg-toss-50 px-2 py-1 rounded-lg press"
          >
            전체 보기
          </Link>
        ) : undefined
      }
    >
      <RecentActivityWidget address={address} limit={5} />
    </Section>
  );
}

// ── Balance split mini-card (지갑 / 모으기) ─────────────────────────────────

function BalanceSplit({
  label, amountWKRC, hidden, loading, muted,
}: {
  label: string;
  amountWKRC: number;
  hidden: boolean;
  loading?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="rounded-toss bg-neutral-50 px-3.5 py-3">
      <p className="text-[11px] font-medium text-neutral-500">{label}</p>
      {loading ? (
        <Skeleton className="mt-1.5 h-5 w-20 rounded" />
      ) : (
        <p className={cn(
          "mt-1 text-[15px] font-black tabular-nums tracking-tight",
          muted && amountWKRC === 0 ? "text-neutral-300" : "text-neutral-900",
        )}>
          {hidden ? "••••" : Math.round(amountWKRC).toLocaleString("ko-KR")}
          <span className="text-[12px] font-bold ml-0.5">원</span>
        </p>
      )}
    </div>
  );
}

// ── Promo card ───────────────────────────────────────────────────────────────

function PromoCard({
  href, icon, iconBg, iconBgStyle, title, desc, badge, external,
}: {
  href: string;
  icon: React.ReactNode;
  iconBg?: string;
  iconBgStyle?: React.CSSProperties;
  title: string;
  desc: string;
  badge: string;
  external?: boolean;
}) {
  const content = (
    <>
      <span
        className={cn("w-10 h-10 rounded-full flex items-center justify-center shrink-0", iconBg)}
        style={iconBgStyle}
      >
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <p className="text-[14px] font-bold text-neutral-900 truncate">{title}</p>
          <span className="text-[10px] font-bold text-neutral-400 bg-neutral-50 px-1.5 py-0.5 rounded">
            {badge}
          </span>
        </div>
        <p className="text-[12px] text-neutral-500 truncate">{desc}</p>
      </div>
      {external ? (
        <ExternalLink size={14} className="text-neutral-300 shrink-0" />
      ) : (
        <ChevronRight size={16} className="text-neutral-300 shrink-0" />
      )}
    </>
  );

  const className = "flex items-center gap-3 rounded-toss-lg bg-white px-5 py-4 press hover:bg-neutral-25";

  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        {content}
      </a>
    );
  }
  return <Link href={href} className={className}>{content}</Link>;
}

// ── Quick action ─────────────────────────────────────────────────────────────

function QuickAction({
  href,
  onClick,
  label,
  icon,
  disabled,
}: {
  href?: string;
  onClick?: () => void;
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
}) {
  const inner = (
    <div className={cn(
      "flex flex-col items-center gap-1.5 py-2 press rounded-toss w-full",
      disabled && "opacity-40 pointer-events-none",
    )}>
      <div className="w-11 h-11 rounded-full bg-neutral-50 text-toss-500 flex items-center justify-center">
        {icon}
      </div>
      <span className="text-[12px] font-medium text-neutral-700">{label}</span>
    </div>
  );
  if (disabled) return <div>{inner}</div>;
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="contents">
        {inner}
      </button>
    );
  }
  return <Link href={href!}>{inner}</Link>;
}

// ── Holding row ──────────────────────────────────────────────────────────────

function HoldingRow({
  holding,
  hidden,
}: {
  holding: {
    token: Token;
    raw: bigint | undefined;
    human: number;
    wkrcPrice: number | undefined;
    wkrcValue: number | undefined;
  };
  hidden: boolean;
}) {
  const { token, human, wkrcValue } = holding;
  const empty = human === 0;

  return (
    <div
      className={cn(
        "flex items-center gap-3 px-5 py-3.5 press hover:bg-neutral-25",
        empty && "opacity-50",
      )}
    >
      <span className="w-11 h-11 shrink-0 rounded-full bg-neutral-50 flex items-center justify-center text-[20px]">
        {token.logoUrl ?? "🪙"}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-[15px] font-bold text-neutral-900 truncate">{token.symbol}</p>
        <p className="text-[12px] text-neutral-400 truncate">{token.name}</p>
      </div>
      <div className="text-right shrink-0">
        <p className="text-[15px] font-bold text-neutral-900 tabular-nums">
          {hidden ? "••••" : formatTokenAmount(human, token.decimals)}
        </p>
        {wkrcValue !== undefined && token.symbol !== "WKRC" && (
          <p className="text-[12px] text-neutral-400 tabular-nums">
            {hidden ? "••••" : `${Math.round(wkrcValue).toLocaleString("ko-KR")}원`}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function dedupeTokens(states: PoolState[]): Token[] {
  const map = new Map<string, Token>();
  for (const s of states) {
    map.set(s.token0.address.toLowerCase(), s.token0);
    map.set(s.token1.address.toLowerCase(), s.token1);
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.symbol === "WKRC") return -1;
    if (b.symbol === "WKRC") return 1;
    return a.symbol.localeCompare(b.symbol);
  });
}
