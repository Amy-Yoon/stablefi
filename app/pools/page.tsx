"use client";

import { PoolList } from "@/components/pool/PoolList";
import { AlertCircle, Wallet, TrendingUp } from "lucide-react";
import { KNOWN_POOLS } from "@/lib/chain";
import { usePoolsAggregate } from "@/hooks/usePoolsAggregate";
import { useWallet } from "@/context/WalletContext";
import { PrimaryButton } from "@/components/ui/PrimaryButton";
import { PageHeader } from "@/components/ui/PageHeader";

export default function PoolsPage() {
  const { pools, loading, errors } = usePoolsAggregate(KNOWN_POOLS);
  const { isConnected, openPicker, isConnecting } = useWallet();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="모으기" desc="맡겨두기만 해도 수익이 매일 쌓여요" />

      {/* ── 지갑 연결 안내 — connect first, before deposits ─────────────── */}
      {!isConnected && (
        <div className="rounded-toss-lg bg-white p-5">
          <div className="flex items-start gap-3">
            <span
              className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
              style={{ backgroundColor: "#E8F3FF" }}
            >
              <Wallet size={18} style={{ color: "#3182F6" }} />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[15px] font-bold text-neutral-900">
                지갑을 먼저 연결해주세요
              </p>
              <p className="text-[12px] text-neutral-500 mt-1 leading-relaxed">
                지갑을 연결하면 원하는 상품에 맡기고
                <br />수수료 수익을 받을 수 있어요
              </p>
            </div>
          </div>
          <PrimaryButton
            onClick={openPicker}
            loading={isConnecting}
            className="mt-4"
          >
            {isConnecting ? "연결 중..." : "지갑 연결하기"}
          </PrimaryButton>
        </div>
      )}

      {errors.length > 0 && (
        <div className="flex items-start gap-2 p-4 rounded-toss bg-gain-50">
          <AlertCircle size={14} className="text-gain-500 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-[12px] font-bold text-gain-600">
              일부 상품을 불러오지 못했어요 ({errors.length}/{KNOWN_POOLS.length})
            </p>
            {errors.map((e, i) => (
              <p
                key={i}
                className="text-[11px] text-gain-500/80 mt-0.5 break-words font-mono"
              >
                · {e.label}: {e.message}
              </p>
            ))}
          </div>
        </div>
      )}

      <PoolList pools={pools} loading={loading} />
    </div>
  );
}
