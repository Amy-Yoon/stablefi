"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ArrowLeftRight, ExternalLink, XCircle } from "lucide-react";
import { useWallet } from "@/context/WalletContext";
import { STABLENET_TESTNET } from "@/lib/chain";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { PrimaryButton } from "@/components/ui/PrimaryButton";
import { Skeleton } from "@/components/ui/Skeleton";
import { ActivityRow, type ExplorerTx } from "@/components/activity/ActivityRow";
import { useActivity } from "@/hooks/useActivity";

// ── Transaction history page ────────────────────────────────────────────────
// 거래 내역을 앱 안에서 직접 보여준다. 데이터는 /api/activity 프록시를 통해
// 체인 익스플로러(Blockscout v2 → v1 순)에서 받아온다. 응답 스키마는 API
// 라우트가 통일해 내려주므로 여기서는 그룹핑 + 렌더링만 담당. Row 자체는
// components/activity/ActivityRow를 공유해 홈 위젯과 동일한 규칙으로 분류됨.
//
// 쿼리는 hooks/useActivity 의 공용 훅으로 위임. 홈 위젯 / 홈 Section 래퍼와
// queryKey + queryFn 이 모두 같아야 React Query cache 가 정상 dedup 됨.

export default function ActivityPage() {
  const { address, isConnected, openPicker, isConnecting } = useWallet();

  const { data, isLoading, isError, error, refetch, isFetching } =
    useActivity(address, 100);

  const items = data?.items ?? [];
  const me = address ?? "";

  // 날짜 구간별로 묶어서 보여준다 (오늘 / 어제 / 이전).
  const grouped = useMemo(() => {
    const today: ExplorerTx[] = [];
    const yesterday: ExplorerTx[] = [];
    const earlier: ExplorerTx[] = [];
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
    const startOfYesterday = startOfToday - 86400;
    for (const tx of items) {
      const t = Number(tx.timeStamp);
      if (t >= startOfToday)          today.push(tx);
      else if (t >= startOfYesterday) yesterday.push(tx);
      else                            earlier.push(tx);
    }
    return { today, yesterday, earlier };
  }, [items]);

  // ── Unconnected ─────────────────────────────────────────────────────────
  if (!isConnected) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="거래 내역" desc="이 지갑의 모든 활동을 한눈에 봐요" />
        <Section>
          <div className="rounded-toss-lg bg-white p-6 text-center">
            <p className="text-[14px] font-bold text-neutral-900">지갑을 먼저 연결해주세요</p>
            <p className="text-[12px] text-neutral-400 mt-1 mb-5">
              연결하면 이 지갑의 거래 내역을 불러와요
            </p>
            <PrimaryButton onClick={openPicker} loading={isConnecting}>
              {isConnecting ? "연결 중..." : "지갑 연결"}
            </PrimaryButton>
          </div>
        </Section>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="거래 내역"
        desc="이 지갑의 최근 활동 100건까지 보여줘요"
        action={
          <a
            href={`${STABLENET_TESTNET.explorer}/address/${address}`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-[12px] font-bold text-toss-500 hover:bg-toss-50 press"
          >
            익스플로러 <ExternalLink size={12} />
          </a>
        }
      />

      {/* ── Loading ──────────────────────────────────────────────────────── */}
      {isLoading && (
        <Section>
          <div className="bg-white rounded-toss-lg overflow-hidden">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-5 py-3.5">
                <Skeleton className="w-10 h-10 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-24 rounded" />
                  <Skeleton className="h-3 w-36 rounded" />
                </div>
                <Skeleton className="h-4 w-16 rounded" />
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* ── Error ─────────────────────────────────────────────────────── */}
      {isError && (
        <Section>
          <div className="rounded-toss-lg bg-white p-6 text-center">
            <XCircle size={22} className="text-gain-500 mx-auto mb-2" />
            <p className="text-[14px] font-bold text-neutral-900">거래 내역을 불러오지 못했어요</p>
            <p className="text-[12px] text-neutral-400 mt-1 mb-4 font-mono break-words">
              {(error as any)?.message ?? String(error)}
            </p>
            <PrimaryButton onClick={() => refetch()}>다시 시도</PrimaryButton>
          </div>
        </Section>
      )}

      {/* ── Empty ────────────────────────────────────────────────────── */}
      {!isLoading && !isError && items.length === 0 && (
        <Section>
          <div className="rounded-toss-lg bg-white p-8 text-center">
            <div className="w-14 h-14 mx-auto rounded-full bg-neutral-50 flex items-center justify-center mb-3">
              <ArrowLeftRight size={22} className="text-neutral-300" />
            </div>
            <p className="text-[14px] font-bold text-neutral-900">아직 거래 내역이 없어요</p>
            <p className="text-[12px] text-neutral-400 mt-1 mb-5">
              첫 번째 바꾸기나 모으기로 시작해보세요
            </p>
            <div className="flex gap-2 justify-center">
              <Link
                href="/swap"
                className="px-4 py-2 rounded-toss bg-toss-500 text-white text-[13px] font-bold press"
              >
                바꾸기
              </Link>
              <Link
                href="/pools"
                className="px-4 py-2 rounded-toss bg-neutral-50 text-neutral-700 text-[13px] font-bold press"
              >
                모으기
              </Link>
            </div>
            {/* RPC 진단 — 어떤 lookback에서 얼마나 스캔했는지 */}
            {(data?.error || data?.debug) && (
              <details className="mt-5 text-left">
                <summary className="text-[11px] font-bold text-neutral-400 cursor-pointer">
                  진단 정보
                </summary>
                <div className="mt-2 rounded bg-neutral-50 p-2 text-[10px] font-mono text-neutral-600 break-all space-y-1">
                  <p>source: {data?.source}</p>
                  {data?.error && <p className="text-gain-500">error: {data.error}</p>}
                  {data?.debug && (
                    <pre className="whitespace-pre-wrap opacity-80">
                      {JSON.stringify(data.debug, null, 2)}
                    </pre>
                  )}
                </div>
              </details>
            )}
          </div>
        </Section>
      )}

      {/* ── List ─────────────────────────────────────────────────────── */}
      {!isLoading && !isError && items.length > 0 && (
        <>
          {grouped.today.length > 0 && (
            <Section
              title="오늘"
              action={
                isFetching ? (
                  <span className="text-[11px] text-neutral-400 font-medium">새로고침 중…</span>
                ) : (
                  <button
                    onClick={() => refetch()}
                    className="text-[12px] font-bold text-toss-500 hover:bg-toss-50 px-2 py-1 rounded-lg press"
                  >
                    새로고침
                  </button>
                )
              }
            >
              <div className="bg-white rounded-toss-lg overflow-hidden">
                {grouped.today.map((tx) => (
                  <ActivityRow key={tx.hash} tx={tx} myAddress={me} />
                ))}
              </div>
            </Section>
          )}

          {grouped.yesterday.length > 0 && (
            <Section title="어제">
              <div className="bg-white rounded-toss-lg overflow-hidden">
                {grouped.yesterday.map((tx) => (
                  <ActivityRow key={tx.hash} tx={tx} myAddress={me} />
                ))}
              </div>
            </Section>
          )}

          {grouped.earlier.length > 0 && (
            <Section title="이전">
              <div className="bg-white rounded-toss-lg overflow-hidden">
                {grouped.earlier.map((tx) => (
                  <ActivityRow key={tx.hash} tx={tx} myAddress={me} />
                ))}
              </div>
            </Section>
          )}

          <p className="text-center text-[11px] text-neutral-300 pt-1">
            최근 {items.length}건 · 더 자세한 내역은 익스플로러에서 볼 수 있어요
          </p>
        </>
      )}
    </div>
  );
}
