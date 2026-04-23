"use client";

// Token picker used by the swap page. Lists every token surfaced by any known
// pool (dedupe happens in the parent). Toss-style: big round avatars + tap rows.

import { useState } from "react";
import { Search, X } from "lucide-react";
import type { Token } from "@/lib/chain";

interface TokenSelectModalProps {
  tokens: Token[];
  onSelect: (token: Token) => void;
  onClose: () => void;
  exclude?: string;
}

export function TokenSelectModal({ tokens, onSelect, onClose, exclude }: TokenSelectModalProps) {
  const [query, setQuery] = useState("");

  const filtered = tokens.filter(
    (t) =>
      t.address !== exclude &&
      (t.symbol.toLowerCase().includes(query.toLowerCase()) ||
        t.name.toLowerCase().includes(query.toLowerCase()))
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-md" onClick={onClose} />

      <div className="relative w-full max-w-sm bg-white shadow-dropdown overflow-hidden mx-0 sm:mx-4 rounded-t-toss-lg sm:rounded-toss-lg">
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <h3 className="text-[16px] font-bold text-neutral-900">토큰 선택</h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-neutral-50 text-neutral-400 hover:text-neutral-700 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="mx-5 mb-3 flex items-center gap-2 px-3 py-2.5 rounded-toss bg-neutral-50">
          <Search size={14} className="text-neutral-400 shrink-0" />
          <input
            autoFocus
            placeholder="이름 또는 주소 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 bg-transparent text-sm text-neutral-900 placeholder:text-neutral-400 outline-none"
          />
        </div>

        <div className="max-h-80 overflow-y-auto pb-4">
          {filtered.length === 0 ? (
            <p className="text-center text-sm text-neutral-400 py-8">토큰을 찾을 수 없어요</p>
          ) : (
            filtered.map((token) => (
              <button
                key={token.address}
                onClick={() => onSelect(token)}
                className="w-full flex items-center gap-3 px-5 py-3 press hover:bg-neutral-25 text-left"
              >
                <span className="w-10 h-10 rounded-full bg-neutral-50 flex items-center justify-center text-[20px]">
                  {token.logoUrl ?? "🪙"}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-[15px] font-bold text-neutral-900">{token.symbol}</p>
                  <p className="text-[12px] text-neutral-400 truncate">{token.name}</p>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
