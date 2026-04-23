"use client";

import Link from "next/link";
import { ArrowLeftRight } from "lucide-react";
import { Skeleton } from "@/components/ui/Skeleton";
import { ActivityRow } from "./ActivityRow";
import { useActivity } from "@/hooks/useActivity";

// ── Recent Activity Widget ──────────────────────────────────────────────────
// Drop-in block for the home page: shows up to `limit` most recent
// transactions. The "전체 보기" action lives on the parent Section header
// (상단 액션 원칙) — no footer row. Uses the shared ActivityRow so row
// styling / icons / labels stay identical to the full page.

interface Props {
  address: string;
  limit?: number;
}

export function RecentActivityWidget({ address, limit = 5 }: Props) {
  // 공용 훅 — /activity 페이지 / 홈 Section 래퍼와 같은 queryKey / queryFn
  // 을 공유해서 하나의 fetch 로 모두 재사용. 이전엔 같은 key에 서로 다른
  // queryFn이 붙어있어서 React Query가 경고 + 레이스 상태에 빠졌음 (widget
  // 의 readWalletBlockNumber await 가 hang 하면 permanent loading).
  const { data, isLoading, isError } = useActivity(address, 20);

  const items = (data?.items ?? []).slice(0, limit);

  // Skeleton — always render something so the layout doesn't jump.
  if (isLoading) {
    return (
      <div className="bg-white rounded-toss-lg overflow-hidden">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-5 py-3">
            <Skeleton className="w-10 h-10 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-20 rounded" />
              <Skeleton className="h-3 w-32 rounded" />
            </div>
            <Skeleton className="h-4 w-14 rounded" />
          </div>
        ))}
      </div>
    );
  }

  // Errors on the home page are quietly swallowed with a minimal stub —
  // the dedicated /activity page surfaces full diagnostics.
  if (isError) {
    return (
      <div className="bg-white rounded-toss-lg p-5 text-center">
        <p className="text-[13px] text-neutral-400">거래 내역을 불러오지 못했어요</p>
        <Link
          href="/activity"
          className="inline-block mt-2 text-[12px] font-bold text-toss-500 press"
        >
          거래 내역 페이지로 →
        </Link>
      </div>
    );
  }

  if (items.length === 0) {
    // 빈 상태에선 "전체 보기"를 숨겨야 한다 — 클릭해도 똑같이 빈 페이지라
    // 사용자에게 이동 가치를 제공 못하고 오히려 혼란만 준다. 전체 보기 링크는
    // 홈 Section action에 하나, 위젯 하단에 하나 — 둘 다 empty 상태에선 불필요.
    return (
      <div className="bg-white rounded-toss-lg p-6 text-center">
        <div className="w-10 h-10 mx-auto rounded-full bg-neutral-50 flex items-center justify-center mb-2">
          <ArrowLeftRight size={18} className="text-neutral-300" />
        </div>
        <p className="text-[13px] font-bold text-neutral-900">아직 거래 내역이 없어요</p>
        <p className="text-[11px] text-neutral-400 mt-0.5">
          첫 번째 바꾸기나 모으기로 시작해보세요
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-toss-lg overflow-hidden">
      {items.map((tx) => (
        <ActivityRow
          key={tx.hash}
          tx={tx}
          myAddress={address}
          compact
          hideTargetBadge
        />
      ))}
    </div>
  );
}

