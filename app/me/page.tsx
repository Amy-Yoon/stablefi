"use client";

import Link from "next/link";
import { useWallet } from "@/context/WalletContext";
import { shortenAddress } from "@/lib/utils";
import {
  Wallet, AlertTriangle, LogOut, Copy, ExternalLink, ChevronRight,
  CheckCircle2, XCircle, Loader2, History,
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { STABLENET_TESTNET } from "@/lib/chain";
import { useRpcHealth } from "@/hooks/useRpcHealth";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { PrimaryButton } from "@/components/ui/PrimaryButton";

export default function MePage() {
  const { address, isConnected, isConnecting, isWrongNetwork, openPicker, disconnect, switchToStableNet } = useWallet();
  const { toast } = useToast();
  const rpc = useRpcHealth();

  const copyAddress = async () => {
    if (!address) return;
    await navigator.clipboard.writeText(address);
    toast("주소를 복사했어요", "success");
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="내 계정" desc="지갑과 네트워크 정보를 관리해요" />

      {/* 연결 전 */}
      {!isConnected && (
        <Section>
          <div className="rounded-toss-lg bg-white p-6 text-center">
            <div className="w-14 h-14 mx-auto rounded-full bg-neutral-50 flex items-center justify-center mb-3">
              <Wallet size={24} className="text-neutral-400" />
            </div>
            <p className="text-[15px] font-bold text-neutral-900">지갑이 연결되어 있지 않아요</p>
            <p className="text-[12px] text-neutral-400 mt-1 mb-5">
              지갑을 연결하면 바꾸기, 모으기를 시작할 수 있어요
            </p>
            <PrimaryButton onClick={openPicker} loading={isConnecting}>
              {isConnecting ? "연결 중..." : "지갑 연결"}
            </PrimaryButton>
          </div>
        </Section>
      )}

      {/* 연결 후 */}
      {isConnected && (
        <Section title="내 지갑">
          <div className="rounded-toss-lg bg-white overflow-hidden">
            <div className="px-5 py-4">
              <p className="text-[11px] font-medium text-neutral-400 mb-1">연결된 지갑 주소</p>
              <div className="flex items-center justify-between">
                <p className="text-[14px] font-mono font-bold text-neutral-900">{shortenAddress(address!)}</p>
                <button
                  onClick={copyAddress}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg text-[12px] font-bold text-toss-500 hover:bg-toss-50 press"
                >
                  <Copy size={12} /> 복사
                </button>
              </div>
            </div>

            <div className="px-5 py-4 flex items-center justify-between border-t border-neutral-50">
              <div>
                <p className="text-[11px] font-medium text-neutral-400 mb-1">연결 네트워크</p>
                <div className="flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${isWrongNetwork ? "bg-amber-400" : "bg-emerald-400"}`} />
                  <p className="text-[14px] font-bold text-neutral-900">
                    {isWrongNetwork ? "다른 네트워크" : STABLENET_TESTNET.name}
                  </p>
                </div>
              </div>
              {isWrongNetwork && (
                <button
                  onClick={switchToStableNet}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-amber-50 text-amber-700 text-[12px] font-bold hover:bg-amber-100 press"
                >
                  <AlertTriangle size={12} />
                  전환하기
                </button>
              )}
            </div>
          </div>
        </Section>
      )}

      {/* 네트워크 상태 — home의 Section 패턴과 동일하게 타이틀 바깥, 그리드 내부 */}
      <Section title="네트워크 상태">
        <div className="rounded-toss-lg bg-white p-5">
          {rpc.isLoading && (
            <div className="flex items-center gap-2 text-[13px] text-neutral-500">
              <Loader2 size={14} className="animate-spin" /> 확인 중…
            </div>
          )}

          {rpc.isError && (
            <div className="flex items-start gap-2">
              <XCircle size={16} className="text-gain-500 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-bold text-gain-600">RPC 연결 실패</p>
                <p className="text-[11px] text-gain-500/80 font-mono break-words mt-1">
                  {(rpc.error as any)?.shortMessage ?? (rpc.error as any)?.message ?? String(rpc.error)}
                </p>
              </div>
            </div>
          )}

          {rpc.data && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 size={14} className="text-emerald-500" />
                <p className="text-[12px] font-bold text-emerald-600">연결 양호</p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <InfoCell
                  label="체인 ID"
                  value={String(rpc.data.chainId)}
                  warn={rpc.data.chainId !== STABLENET_TESTNET.id ? `예상 ${STABLENET_TESTNET.id}` : undefined}
                />
                <InfoCell
                  label="최신 블록"
                  value={String(rpc.data.blockNumber)}
                />
              </div>
              <div className="pt-2 border-t border-neutral-50">
                <p className="text-[11px] font-medium text-neutral-400 mb-1">RPC 엔드포인트</p>
                <p className="text-[12px] font-mono text-neutral-700 break-all">
                  {STABLENET_TESTNET.rpcUrl}
                </p>
              </div>
            </div>
          )}
        </div>
      </Section>

      {isConnected && (
        <Section title="바로가기">
          <div className="rounded-toss-lg bg-white overflow-hidden">
            <Link
              href="/activity"
              className="flex items-center justify-between px-5 py-4 press hover:bg-neutral-25"
            >
              <div className="flex items-center gap-2.5">
                <History size={16} className="text-neutral-400" />
                <p className="text-[14px] font-bold text-neutral-700">거래 내역</p>
              </div>
              <ChevronRight size={16} className="text-neutral-300" />
            </Link>
            <a
              href={`${STABLENET_TESTNET.explorer}/address/${address}`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between px-5 py-4 press hover:bg-neutral-25 border-t border-neutral-50"
            >
              <div className="flex items-center gap-2.5">
                <ExternalLink size={16} className="text-neutral-400" />
                <p className="text-[14px] font-bold text-neutral-700">익스플로러에서 보기</p>
              </div>
              <ChevronRight size={16} className="text-neutral-300" />
            </a>
          </div>

          <button
            onClick={disconnect}
            className="mt-2 flex items-center justify-center gap-2 w-full h-12 rounded-toss bg-white text-gain-500 text-[14px] font-bold hover:bg-gain-50 press"
          >
            <LogOut size={14} />
            로그아웃
          </button>
        </Section>
      )}
    </div>
  );
}

// ── InfoCell — mini stat inside a card, grid-friendly ──────────────────────
function InfoCell({ label, value, warn }: { label: string; value: string; warn?: string }) {
  return (
    <div className="rounded-toss bg-neutral-50 px-3.5 py-3">
      <p className="text-[11px] font-medium text-neutral-500">{label}</p>
      <p className="mt-1 text-[15px] font-black text-neutral-900 tabular-nums tracking-tight break-all">
        {value}
      </p>
      {warn && (
        <p className="text-[10px] font-bold text-amber-600 mt-0.5">{warn}</p>
      )}
    </div>
  );
}
