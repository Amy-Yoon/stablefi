"use client";

import { useState } from "react";
import { X, Copy, Check, AlertTriangle } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { STABLENET_TESTNET } from "@/lib/chain";

// Show the wallet's receive address + a QR so the user can scan it from
// another device. The QR image is generated via a public QR service —
// safe to use here because the address is public information anyway.

interface ReceiveModalProps {
  address: string;
  onClose: () => void;
}

export function ReceiveModal({ address, onClose }: ReceiveModalProps) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=0&data=${encodeURIComponent(address)}`;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    toast("주소를 복사했어요", "success");
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-md" onClick={onClose} />

      <div className="relative w-full max-w-sm bg-white mx-0 sm:mx-4 rounded-t-toss-lg sm:rounded-toss-lg overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <h3 className="text-[16px] font-bold text-neutral-900">토큰 받기</h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-neutral-50 text-neutral-400 hover:text-neutral-700 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* QR */}
        <div className="flex justify-center px-5 pb-2">
          <div className="p-4 rounded-toss bg-white border border-neutral-100">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={qrSrc}
              alt="지갑 주소 QR 코드"
              width={240}
              height={240}
              className="block"
            />
          </div>
        </div>

        {/* Address + copy */}
        <div className="px-5 pt-3 pb-4">
          <p className="text-[11px] font-medium text-neutral-400 mb-1.5 px-1">지갑 주소</p>
          <div className="flex items-center gap-2 p-3 rounded-toss bg-neutral-50">
            <p className="flex-1 text-[12px] font-mono font-bold text-neutral-900 break-all">
              {address}
            </p>
            <button
              onClick={handleCopy}
              className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white text-[12px] font-bold text-toss-500 hover:bg-toss-50 press"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? "복사됨" : "복사"}
            </button>
          </div>

          {/* Testnet warning */}
          <div className="mt-3 flex items-start gap-2 px-1">
            <AlertTriangle size={12} className="text-amber-500 shrink-0 mt-0.5" />
            <p className="text-[11px] text-neutral-500 leading-relaxed">
              <span className="font-bold text-amber-600">{STABLENET_TESTNET.name}</span>에서만 받을 수 있어요.
              다른 네트워크에서 보낸 토큰은 되돌릴 수 없어요.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
