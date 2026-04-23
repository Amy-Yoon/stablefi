"use client";

import { useState } from "react";
import { X, Loader2, Send, Wallet, ChevronDown, AlertTriangle } from "lucide-react";
import { formatUnits, parseUnits, isAddress, type Abi } from "viem";
import { useQueryClient } from "@tanstack/react-query";
import { useWallet } from "@/context/WalletContext";
import { useToast } from "@/components/ui/Toast";
import { useTokenBalance } from "@/hooks/useToken";
import type { Token } from "@/lib/chain";
import { formatToken, formatTokenAmount, cn } from "@/lib/utils";
import { writeAndWait, friendlyTxError, isStaleWalletError, verifyConnection, type TxStatus } from "@/lib/tx";
import ERC20Json from "@/lib/abi/ERC20.json";

const ERC20 = ERC20Json as Abi;

interface SendModalProps {
  tokens: Token[];
  initialToken?: Token;
  onClose: () => void;
}

export function SendModal({ tokens, initialToken, onClose }: SendModalProps) {
  const { address, disconnect } = useWallet();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [token, setToken] = useState<Token>(initialToken ?? tokens[0]);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [txStatus, setTxStatus] = useState<TxStatus | null>(null);
  const [showTokenPicker, setShowTokenPicker] = useState(false);

  const { data: balanceRaw } = useTokenBalance(
    token?.address,
    address as `0x${string}` | undefined,
  );
  const balanceHuman = balanceRaw
    ? Number(formatUnits(balanceRaw, token.decimals))
    : 0;

  const amountNum = parseFloat(amount) || 0;
  const isValidAddress = to.length > 0 && isAddress(to);
  const isSelfSend = isValidAddress && address && to.toLowerCase() === address.toLowerCase();
  const exceedsBalance = amountNum > balanceHuman;

  const canSend =
    !!address &&
    isValidAddress &&
    !isSelfSend &&
    amountNum > 0 &&
    !exceedsBalance;

  const handleMax = () => {
    if (!balanceRaw) return;
    setAmount(formatUnits(balanceRaw, token.decimals));
  };

  const handleSend = async () => {
    if (!canSend || !address) return;
    setLoading(true);
    setTxStatus(null);
    try {
      const value = parseUnits(amount, token.decimals);
      await writeAndWait({
        account: address as `0x${string}`,
        address: token.address,
        abi: ERC20,
        functionName: "transfer",
        args: [to as `0x${string}`, value],
        onStatus: setTxStatus,
      });
      toast(
        `${formatToken(amountNum, token.symbol, token.decimals)} 보냈어요`,
        "success",
      );
      queryClient.invalidateQueries({ queryKey: ["tokenBalance"] });
      // 보내기도 거래내역에 찍혀야 하므로 같이 invalidate.
      queryClient.invalidateQueries({ queryKey: ["activity"] });
      onClose();
    } catch (e: any) {
      toast(friendlyTxError(e), "error");
      // Double-check the wallet actually lost our session before we drop it —
      // otherwise ambiguous errors (busy wallet, RPC hiccup) would kick the
      // user out unnecessarily.
      if (isStaleWalletError(e)) {
        const stillConnected = await verifyConnection();
        if (!stillConnected) {
          disconnect();
          onClose();
        }
      }
    } finally {
      setLoading(false);
      setTxStatus(null);
    }
  };

  const ctaLabel = loading
    ? txStatus?.label ?? "처리 중..."
    : !isValidAddress && to.length > 0
    ? "올바른 주소가 아니에요"
    : isSelfSend
    ? "내 주소로는 보낼 수 없어요"
    : exceedsBalance
    ? "잔액이 부족해요"
    : amountNum === 0
    ? "금액을 입력해주세요"
    : !isValidAddress
    ? "받는 주소를 입력해주세요"
    : "보내기";

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-md" onClick={onClose} />

      <div className="relative w-full max-w-sm bg-white mx-0 sm:mx-4 rounded-t-toss-lg sm:rounded-toss-lg overflow-hidden max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 shrink-0">
          <h3 className="text-[16px] font-bold text-neutral-900">토큰 보내기</h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-neutral-50 text-neutral-400 hover:text-neutral-700 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-4 space-y-3">
          {/* Token selector */}
          <div>
            <p className="text-[11px] font-medium text-neutral-400 mb-1.5 px-1">토큰</p>
            <button
              onClick={() => setShowTokenPicker((v) => !v)}
              className="w-full flex items-center gap-3 p-3 rounded-toss bg-neutral-50 hover:bg-neutral-100 press"
            >
              <span className="w-9 h-9 rounded-full bg-white flex items-center justify-center text-[18px]">
                {token.logoUrl ?? "🪙"}
              </span>
              <div className="flex-1 text-left min-w-0">
                <p className="text-[14px] font-bold text-neutral-900">{token.symbol}</p>
                <p className="text-[11px] text-neutral-400 truncate">
                  잔액 {formatTokenAmount(balanceHuman, token.decimals)}
                </p>
              </div>
              <ChevronDown size={14} className={cn(
                "text-neutral-400 transition-transform",
                showTokenPicker && "rotate-180",
              )} />
            </button>

            {showTokenPicker && (
              <div className="mt-1 rounded-toss bg-neutral-50 overflow-hidden">
                {tokens.map((t) => (
                  <button
                    key={t.address}
                    onClick={() => {
                      setToken(t);
                      setShowTokenPicker(false);
                      setAmount("");
                    }}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-2.5 press hover:bg-white text-left",
                      t.address === token.address && "bg-white",
                    )}
                  >
                    <span className="w-8 h-8 rounded-full bg-white flex items-center justify-center text-[16px]">
                      {t.logoUrl ?? "🪙"}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-bold text-neutral-900">{t.symbol}</p>
                      <p className="text-[11px] text-neutral-400 truncate">{t.name}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Recipient */}
          <div>
            <p className="text-[11px] font-medium text-neutral-400 mb-1.5 px-1">받는 주소</p>
            <input
              value={to}
              onChange={(e) => setTo(e.target.value.trim())}
              placeholder="0x..."
              spellCheck={false}
              autoComplete="off"
              className={cn(
                "w-full p-3 rounded-toss bg-neutral-50 outline-none text-[13px] font-mono",
                "placeholder:text-neutral-300 placeholder:font-sans",
                "focus:bg-white focus:ring-2",
                to.length === 0 || isValidAddress
                  ? "focus:ring-toss-500 text-neutral-900"
                  : "ring-2 ring-gain-500 text-gain-600",
              )}
            />
            {to.length > 0 && !isValidAddress && (
              <p className="mt-1.5 text-[11px] text-gain-500 px-1 flex items-center gap-1">
                <AlertTriangle size={11} /> 올바른 지갑 주소 형식이 아니에요
              </p>
            )}
          </div>

          {/* Amount */}
          <div>
            <div className="flex items-center justify-between mb-1.5 px-1">
              <p className="text-[11px] font-medium text-neutral-400">금액</p>
              <div className="flex items-center gap-1.5 text-[11px] text-neutral-400">
                <Wallet size={11} />
                <span className="tabular-nums">
                  {formatTokenAmount(balanceHuman, token.decimals)} {token.symbol}
                </span>
                {balanceHuman > 0 && (
                  <button
                    onClick={handleMax}
                    className="ml-1 px-2 py-0.5 rounded-md text-[10px] font-bold text-toss-500 bg-toss-50 hover:bg-toss-100 press"
                  >
                    최대
                  </button>
                )}
              </div>
            </div>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className={cn(
                "w-full p-3 rounded-toss bg-neutral-50 outline-none text-[18px] font-black tabular-nums tracking-tight",
                "placeholder:text-neutral-300 focus:bg-white focus:ring-2",
                exceedsBalance
                  ? "ring-2 ring-gain-500 text-gain-600"
                  : "focus:ring-toss-500 text-neutral-900",
              )}
            />
          </div>
        </div>

        {/* CTA */}
        <div className="px-5 pb-5 shrink-0">
          <button
            onClick={handleSend}
            disabled={!canSend || loading}
            className={cn(
              "w-full h-14 rounded-toss text-[15px] font-bold transition-colors flex items-center justify-center gap-2 press",
              canSend && !loading
                ? "bg-toss-500 hover:bg-toss-600 text-white"
                : "bg-neutral-200 text-white cursor-not-allowed",
            )}
          >
            {loading
              ? <><Loader2 size={16} className="animate-spin" /> {ctaLabel}</>
              : <><Send size={14} /> {ctaLabel}</>}
          </button>
        </div>
      </div>
    </div>
  );
}
