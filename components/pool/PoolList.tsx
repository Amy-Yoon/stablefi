"use client";

import { useState } from "react";
import { Plus, Minus, ChevronRight, Lock } from "lucide-react";
import { formatWKRC, cn } from "@/lib/utils";
import { PoolModal } from "@/components/pool/PoolModal";
import { Skeleton } from "@/components/ui/Skeleton";
import { PrimaryButton } from "@/components/ui/PrimaryButton";
import { useWallet } from "@/context/WalletContext";
import type { Token } from "@/lib/chain";

// When the user has this many active positions or more, we switch the
// "모으는 중" section from the hero card layout to a compact row list with a
// summary header. 1개짜리 hero card는 여전히 히어로급으로 보여주고, 2개부터는
// 스크롤 없이 한 눈에 들어오게 리스트 형태로 바꾼다.
const COMPACT_THRESHOLD = 2;

export interface PoolPositionSlice {
  tokenId: bigint;
  tickLower: number;
  tickUpper: number;
  /** Raw liquidity units — V3: position.liquidity; V2: LP token balance. Needed
   * to scale withdraw by percent at execution time (decreaseLiquidity /
   * removeLiquidity take raw units, not amounts). */
  liquidity: bigint;
  amount0: number;
  amount1: number;
  owed0: number;
  owed1: number;
}

export interface Pool {
  address: `0x${string}`;
  version: "v2" | "v3";
  token0: Token;
  token1: Token;
  fee?: number;

  // Aggregates — undefined means "집계 중"
  tvlWKRC?: number;
  volume24hWKRC?: number;
  apr?: number;

  // User position — aggregate totals + per-NFT slices (V3 positions combine)
  myDepositedWKRC?: number;
  myEarnedWKRC?: number;
  myPositionSlices?: PoolPositionSlice[];
  /** 누적 수령된 수수료 — V3 한정 (V2 는 LP 가격에 자동 반영). */
  myRealizedFeesWKRC?: number;
  /** 가장 오래된 mint 시각 — UI 의 "X일 전 시작" 표시용. */
  myOldestMintTimestamp?: number;
  /** 풀 단위 weighted-avg 연 환산 수익률 (%) — V3 한정. */
  myEffectiveAPR?: number;
}

interface PoolListProps {
  pools: Pool[];
  loading: boolean;
}

export function PoolList({ pools, loading }: PoolListProps) {
  const [selected, setSelected] = useState<Pool | null>(null);
  const [modalMode, setModalMode] = useState<"deposit" | "withdraw">("deposit");
  const { isConnected, openPicker } = useWallet();

  // Show in "모으는 중" if the user has principal OR uncollected fees.
  const myPools = pools.filter(
    (p) => (p.myDepositedWKRC ?? 0) > 0 || (p.myEarnedWKRC ?? 0) > 0,
  );

  // Block modal entry when disconnected, but surface the picker directly —
  // tapping a pool is an explicit action so opening the wallet chooser is
  // the right follow-up. (Previously we auto-called connect(), which felt
  // invasive; later we fell back to a toast, which was a dead-end.)
  const open = (pool: Pool, mode: "deposit" | "withdraw") => {
    if (!isConnected) {
      openPicker();
      return;
    }
    setSelected(pool);
    setModalMode(mode);
  };

  if (loading) {
    return (
      <div className="bg-white rounded-toss-lg overflow-hidden">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[72px]" />
        ))}
      </div>
    );
  }

  // Aggregate totals for the compact "모으는 중" summary hero.
  const totalDeposited = myPools.reduce((s, p) => s + (p.myDepositedWKRC ?? 0), 0);
  const totalEarned    = myPools.reduce((s, p) => s + (p.myEarnedWKRC    ?? 0), 0);
  const totalEarnedPct = totalDeposited > 0 ? (totalEarned / totalDeposited) * 100 : undefined;

  return (
    <div className="space-y-6">
      {/* ── 모으는 중 (내 포지션) ─────────────────────────────────────────────
           n=1 → 히어로 카드 하나 (큰 숫자가 메인 포커스)
           n≥2 → 요약 헤더 + 컴팩트 행 리스트 (스크롤 안 타게) */}
      {myPools.length > 0 && (
        <section>
          <div className="flex items-baseline justify-between mb-3 px-1">
            <h2 className="text-[14px] font-bold text-neutral-900">모으는 중</h2>
            {myPools.length >= COMPACT_THRESHOLD && (
              <span className="text-[12px] text-neutral-400 tabular-nums">
                {myPools.length}개
              </span>
            )}
          </div>

          {myPools.length < COMPACT_THRESHOLD ? (
            <div className="space-y-3">
              {myPools.map((pool) => (
                <MyPositionCard
                  key={pool.address}
                  pool={pool}
                  onAdd={() => open(pool, "deposit")}
                  onWithdraw={() => open(pool, "withdraw")}
                />
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              <MyPositionsSummary
                totalDeposited={totalDeposited}
                totalEarned={totalEarned}
                totalEarnedPct={totalEarnedPct}
              />
              <div className="bg-white rounded-toss-lg overflow-hidden">
                {myPools.map((pool) => (
                  <MyPositionRow
                    key={pool.address}
                    pool={pool}
                    onOpen={() => open(pool, "deposit")}
                    onWithdraw={() => open(pool, "withdraw")}
                  />
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* ── 전체 상품 — Toss-style flat row list ── */}
      <section>
        <div className="flex items-center justify-between mb-3 px-1">
          <h2 className="text-[14px] font-bold text-neutral-900">
            {myPools.length > 0 ? "더 맡길 수 있어요" : "맡길 수 있는 상품"}
          </h2>
          <span className="text-[12px] text-neutral-400">{pools.length}개</span>
        </div>
        <div className="bg-white rounded-toss-lg overflow-hidden">
          {pools.map((pool) => (
            <PoolRow
              key={pool.address}
              pool={pool}
              onDeposit={() => open(pool, "deposit")}
            />
          ))}
        </div>
      </section>

      {selected && (
        <PoolModal
          pool={selected}
          mode={modalMode}
          onClose={() => setSelected(null)}
          onSwitchMode={(m) => setModalMode(m)}
        />
      )}
    </div>
  );
}

// ── My Position Card ─────────────────────────────────────────────────────────
// Toss-style white card: huge deposit number + red gain line + clear primary CTA.

function MyPositionCard({
  pool,
  onAdd,
  onWithdraw,
}: {
  pool: Pool;
  onAdd: () => void;
  onWithdraw: () => void;
}) {
  // 누적 수수료 (실현 + 미실현). V2 는 realizedFees 가 0/undefined 라 미수령만 표시.
  const totalFees =
    (pool.myEarnedWKRC ?? 0) + (pool.myRealizedFeesWKRC ?? 0);
  const earnedPct =
    pool.myDepositedWKRC && totalFees > 0
      ? (totalFees / pool.myDepositedWKRC) * 100
      : undefined;

  return (
    <div className="bg-white rounded-toss-lg p-5">
      {/* pair header */}
      <div className="flex items-center gap-3 mb-5">
        <TokenPairIcons pool={pool} />
        <div className="flex-1 min-w-0">
          <p className="text-[15px] font-bold text-neutral-900 truncate">
            {pool.token0.symbol} / {pool.token1.symbol}
          </p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <VersionBadge pool={pool} />
            {pool.myOldestMintTimestamp && (
              <span className="text-[11px] text-neutral-400">
                · {formatStartedAgo(pool.myOldestMintTimestamp)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* big deposit number */}
      <div>
        <p className="text-[12px] font-medium text-neutral-500 mb-1">맡긴 금액</p>
        <div className="flex items-baseline gap-1.5">
          <p className="text-[32px] font-black text-neutral-900 tracking-tight tabular-nums leading-none">
            {Math.round(pool.myDepositedWKRC ?? 0).toLocaleString("ko-KR")}
          </p>
          <p className="text-[16px] font-bold text-neutral-900">원</p>
        </div>
      </div>

      {/* earnings — 누적 수수료 (실현+미실현) + 비율 */}
      <p className="text-[13px] font-bold text-gain-500 tabular-nums mt-1.5">
        +{Math.round(totalFees).toLocaleString("ko-KR")}원
        {earnedPct !== undefined && (
          <span className="ml-1 text-gain-500/80">({earnedPct.toFixed(1)}%)</span>
        )}
        {(pool.myRealizedFeesWKRC ?? 0) > 0 && (
          <span className="ml-1.5 text-[11px] font-medium text-neutral-400">
            · 받은 {Math.round(pool.myRealizedFeesWKRC ?? 0).toLocaleString("ko-KR")} · 안 받은 {Math.round(pool.myEarnedWKRC ?? 0).toLocaleString("ko-KR")}
          </span>
        )}
      </p>

      {/* effective APR — 시간 정규화된 연 환산 수익률 */}
      {pool.myEffectiveAPR !== undefined && (
        <div className="mt-3 px-3 py-2 rounded-toss bg-gain-50 flex items-baseline justify-between">
          <p className="text-[12px] font-bold text-neutral-700">연 환산 수익률</p>
          <p className="text-[15px] font-black text-gain-500 tabular-nums">
            {formatAPR(pool.myEffectiveAPR)}
          </p>
        </div>
      )}

      {/* actions */}
      <div className="flex gap-2 mt-5">
        <PrimaryButton
          onClick={onAdd}
          size="md"
          leftIcon={<Plus size={15} />}
          className="flex-1"
        >
          더 맡기기
        </PrimaryButton>
        <PrimaryButton
          onClick={onWithdraw}
          variant="ghost"
          size="md"
          leftIcon={<Minus size={15} />}
          className="flex-1"
        >
          꺼내기
        </PrimaryButton>
      </div>
    </div>
  );
}

// ── APR / 진입경과 시간 formatter ────────────────────────────────────────
// effective APR 은 1000% 까지만 표시 — 그 이상은 초기 풀 노이즈로 간주하고
// ">1000%" 로 캡. 음수는 보호 (이론상 없지만 collect/decrease 추정 오차로 가능).

function formatAPR(apr: number): string {
  if (!Number.isFinite(apr) || apr < 0) return "—";
  if (apr > 1000) return ">1000%";
  return `${apr.toFixed(2)}%`;
}

function formatStartedAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return "방금 시작";
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전 시작`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전 시작`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}일 전 시작`;
  return `${Math.floor(diff / (86400 * 30))}개월 전 시작`;
}

// ── My Positions Summary ─────────────────────────────────────────────────────
// Shown when the user has 2+ active positions. Big total-deposited number at
// top, cumulative earnings underneath. Acts like the "모으는 중" hero so
// individual rows below can be compact.

function MyPositionsSummary({
  totalDeposited,
  totalEarned,
  totalEarnedPct,
}: {
  totalDeposited: number;
  totalEarned: number;
  totalEarnedPct?: number;
}) {
  return (
    <div className="bg-white rounded-toss-lg p-5">
      <p className="text-[12px] font-medium text-neutral-500 mb-1">
        총 맡긴 금액
      </p>
      <div className="flex items-baseline gap-1.5">
        <p className="text-[28px] font-black text-neutral-900 tracking-tight tabular-nums leading-none">
          {Math.round(totalDeposited).toLocaleString("ko-KR")}
        </p>
        <p className="text-[15px] font-bold text-neutral-900">원</p>
      </div>
      <p className="text-[13px] font-bold text-gain-500 tabular-nums mt-1.5">
        +{Math.round(totalEarned).toLocaleString("ko-KR")}원
        {totalEarnedPct !== undefined && totalEarnedPct > 0 && (
          <span className="ml-1 text-gain-500/80">({totalEarnedPct.toFixed(1)}%)</span>
        )}
      </p>
    </div>
  );
}

// ── My Position Row ──────────────────────────────────────────────────────────
// Compact one-line row for multi-position state. Tapping opens the modal on
// the 맡기기 tab by default; the 꺼내기 shortcut sits to the right so power
// users don't need to go through deposit to withdraw.

function MyPositionRow({
  pool,
  onOpen,
  onWithdraw,
}: {
  pool: Pool;
  onOpen: () => void;
  onWithdraw: () => void;
}) {
  const totalFees =
    (pool.myEarnedWKRC ?? 0) + (pool.myRealizedFeesWKRC ?? 0);
  const earnedPct =
    pool.myDepositedWKRC && totalFees > 0
      ? (totalFees / pool.myDepositedWKRC) * 100
      : undefined;

  return (
    <div className="flex items-stretch hover:bg-neutral-25">
      {/* Main clickable area — opens deposit view */}
      <button
        onClick={onOpen}
        className="group flex-1 min-w-0 flex items-center gap-3 px-5 py-4 text-left press"
      >
        <TokenPairIcons pool={pool} compact />
        <div className="flex-1 min-w-0">
          <p className="text-[14px] font-bold text-neutral-900 truncate">
            {pool.token0.symbol} / {pool.token1.symbol}
          </p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <VersionBadge pool={pool} />
            {pool.myEffectiveAPR !== undefined && (
              <span className="text-[10px] font-bold text-gain-500 bg-gain-50 px-1.5 py-0.5 rounded">
                연 {formatAPR(pool.myEffectiveAPR)}
              </span>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="text-[14px] font-bold text-neutral-900 tabular-nums leading-none">
            {Math.round(pool.myDepositedWKRC ?? 0).toLocaleString("ko-KR")}원
          </p>
          {totalFees > 0 && (
            <p className="text-[11px] font-bold text-gain-500 tabular-nums mt-1 leading-none">
              +{Math.round(totalFees).toLocaleString("ko-KR")}원
              {earnedPct !== undefined && (
                <span className="ml-0.5 text-gain-500/80">({earnedPct.toFixed(1)}%)</span>
              )}
            </p>
          )}
        </div>
      </button>
      {/* 꺼내기 shortcut — separated so it doesn't look like part of the row body */}
      <button
        onClick={onWithdraw}
        aria-label="꺼내기"
        className="shrink-0 pl-2 pr-4 text-neutral-400 hover:text-neutral-700 press"
      >
        <Minus size={16} />
      </button>
    </div>
  );
}

// ── Pool Row ─────────────────────────────────────────────────────────────────
// Toss product list row: icon · name · APR big red on right · chevron.
// No shadow, no inner borders — rows live inside a single rounded container.

function PoolRow({ pool, onDeposit }: { pool: Pool; onDeposit: () => void }) {
  const { isConnected } = useWallet();
  return (
    <button
      onClick={onDeposit}
      aria-disabled={!isConnected}
      className={cn(
        "group w-full text-left flex items-center gap-3 px-5 py-4 press",
        isConnected
          ? "hover:bg-neutral-25"
          : "opacity-60 cursor-not-allowed hover:bg-transparent"
      )}
    >
      <TokenPairIcons pool={pool} />

      <div className="flex-1 min-w-0">
        <p className="text-[15px] font-bold text-neutral-900 truncate">
          {pool.token0.symbol} / {pool.token1.symbol}
        </p>
        <div className="flex items-center gap-1.5 mt-0.5">
          <VersionBadge pool={pool} />
          {pool.tvlWKRC !== undefined && (
            <span className="text-[11px] text-neutral-400 tabular-nums">
              · 규모 {formatWKRC(pool.tvlWKRC)}
            </span>
          )}
        </div>
      </div>

      <div className="text-right shrink-0">
        {pool.apr === undefined ? (
          // stats 응답 전 — 아직 모름
          <p className="text-[12px] font-medium text-neutral-300">집계 중</p>
        ) : (pool.volume24hWKRC ?? 0) === 0 ? (
          // 7d 거래량 0 — APR 0% 라기보다 "데이터 없음" 표현이 정직
          <>
            <p className="text-[11px] font-medium text-neutral-400 leading-none">최근 7일</p>
            <p className="text-[13px] font-bold text-neutral-300 tracking-tight leading-none mt-1.5">
              거래 없음
            </p>
          </>
        ) : (
          <>
            <p className="text-[11px] font-medium text-neutral-400 leading-none">연 수익률</p>
            <p className="text-[16px] font-black text-gain-500 tracking-tight tabular-nums leading-none mt-1.5">
              {pool.apr.toFixed(2)}
              <span className="text-[11px] font-bold ml-0.5">%</span>
            </p>
          </>
        )}
      </div>

      {isConnected ? (
        <ChevronRight
          size={18}
          className="text-neutral-200 group-hover:text-neutral-400 shrink-0 ml-0.5"
        />
      ) : (
        <Lock
          size={14}
          className="text-neutral-300 shrink-0 ml-0.5"
          aria-label="지갑 연결 필요"
        />
      )}
    </button>
  );
}

// ── Shared sub-components ────────────────────────────────────────────────────

function TokenPairIcons({ pool, compact }: { pool: Pool; compact?: boolean }) {
  const size = compact ? "w-8 h-8 text-sm" : "w-11 h-11 text-lg";
  return (
    <div className="flex -space-x-2 shrink-0">
      <span className={cn("rounded-full bg-neutral-50 border-2 border-white flex items-center justify-center", size)}>
        {pool.token0.logoUrl ?? "🪙"}
      </span>
      <span className={cn("rounded-full bg-neutral-50 border-2 border-white flex items-center justify-center", size)}>
        {pool.token1.logoUrl ?? "🪙"}
      </span>
    </div>
  );
}

function VersionBadge({ pool }: { pool: Pool }) {
  return (
    <span
      className={cn(
        "text-[10px] px-1.5 py-0.5 rounded font-bold",
        pool.version === "v2"
          ? "bg-toss-50 text-toss-500"
          : "bg-violet-50 text-violet-500",
      )}
    >
      {pool.version.toUpperCase()}
      {pool.fee !== undefined && ` · ${(pool.fee / 10000).toFixed(2)}%`}
    </span>
  );
}
