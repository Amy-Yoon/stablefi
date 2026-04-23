"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertCircle } from "lucide-react";
import { SwapCard } from "@/components/swap/SwapCard";
import { TokenSelectModal } from "@/components/swap/TokenSelectModal";
import { usePoolsAggregate } from "@/hooks/usePoolsAggregate";
import type { PoolState } from "@/hooks/usePool";
import { KNOWN_POOLS, type Token } from "@/lib/chain";
import { findBestRoute } from "@/lib/routing";
import { Skeleton } from "@/components/ui/Skeleton";
import { PageHeader } from "@/components/ui/PageHeader";

type Side = "from" | "to";

export default function SwapPage() {
  const { states, loading, errors } = usePoolsAggregate(KNOWN_POOLS);

  const tokens = useMemo(() => dedupeTokens(states), [states]);

  const [fromToken, setFromToken] = useState<Token | null>(null);
  const [toToken, setToToken] = useState<Token | null>(null);

  // Initialize once pools load — default to TOKEN → WKRC if any WKRC pair exists
  useEffect(() => {
    if (fromToken || toToken) return;
    if (states.length === 0) return;
    const wkrcPool = states.find(
      (s) => s.token0.symbol === "WKRC" || s.token1.symbol === "WKRC",
    );
    const seed = wkrcPool ?? states[0];
    if (seed.token0.symbol === "WKRC") {
      setFromToken(seed.token1);
      setToToken(seed.token0);
    } else {
      setFromToken(seed.token0);
      setToToken(seed.token1);
    }
  }, [states, fromToken, toToken]);

  // Default route for the current from→to direction, computed at size=1.
  // SwapCard re-ranks routes by simulated amountOut using the user's actual
  // inNum — this is just the initial "what's possible between these tokens"
  // check and controls the no-route empty state.
  const bestRoute = useMemo(() => {
    if (!fromToken || !toToken) return null;
    return findBestRoute(states, fromToken, toToken);
  }, [states, fromToken, toToken]);

  // Token select modal
  const [picking, setPicking] = useState<Side | null>(null);

  const handlePick = (t: Token) => {
    if (picking === "from") {
      if (toToken && eq(t.address, toToken.address)) {
        setToToken(fromToken);
      }
      setFromToken(t);
    } else if (picking === "to") {
      if (fromToken && eq(t.address, fromToken.address)) {
        setFromToken(toToken);
      }
      setToToken(t);
    }
    setPicking(null);
  };

  const flipDirection = () => {
    if (!fromToken || !toToken) return;
    setFromToken(toToken);
    setToToken(fromToken);
  };

  return (
    <div className="flex flex-col gap-6">

      <PageHeader title="바꾸기" desc="원하는 토큰을 1초만에 교환해요" />

      {errors.length > 0 && (
        <div className="flex items-start gap-2 p-4 rounded-toss bg-gain-50">
          <AlertCircle size={14} className="text-gain-500 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-[12px] font-bold text-gain-600">일부 풀을 불러오지 못했어요</p>
            {errors.map((e, i) => (
              <p key={i} className="text-[11px] text-gain-500/80 mt-0.5 break-words font-mono">
                · {e.label}: {e.message}
              </p>
            ))}
          </div>
        </div>
      )}

      {loading && states.length === 0 ? (
        <div className="space-y-2">
          <Skeleton className="h-28 rounded-toss-lg" />
          <Skeleton className="h-28 rounded-toss-lg" />
          <Skeleton className="h-14 rounded-toss" />
        </div>
      ) : !fromToken || !toToken ? null : !bestRoute ? (
        <NoRouteCard
          fromSymbol={fromToken.symbol}
          toSymbol={toToken.symbol}
          onFlip={flipDirection}
        />
      ) : (
        <SwapCard
          route={bestRoute}
          pools={states}
          fromToken={fromToken}
          toToken={toToken}
          onPickFrom={() => setPicking("from")}
          onPickTo={() => setPicking("to")}
          onFlip={flipDirection}
        />
      )}

      {picking && (
        <TokenSelectModal
          tokens={tokens}
          onSelect={handlePick}
          onClose={() => setPicking(null)}
          exclude={picking === "from" ? toToken?.address : fromToken?.address}
        />
      )}

    </div>
  );
}

function NoRouteCard({ fromSymbol, toSymbol, onFlip }: {
  fromSymbol: string;
  toSymbol: string;
  onFlip: () => void;
}) {
  return (
    <div className="p-5 rounded-toss-lg bg-white">
      <p className="text-[15px] font-bold text-neutral-900">
        {fromSymbol} → {toSymbol} 교환 경로가 없어요
      </p>
      <p className="text-[13px] text-neutral-500 mt-1 leading-relaxed">
        직접 풀도, 다른 토큰을 경유하는 경로도 없어요. 다른 토큰을 골라보세요.
      </p>
      <button
        onClick={onFlip}
        className="mt-4 w-full h-12 rounded-toss bg-neutral-50 hover:bg-neutral-100 press text-[14px] font-bold text-neutral-700"
      >
        방향 바꾸기
      </button>
    </div>
  );
}

function dedupeTokens(states: PoolState[]): Token[] {
  const map = new Map<string, Token>();
  for (const s of states) {
    map.set(s.token0.address.toLowerCase(), s.token0);
    map.set(s.token1.address.toLowerCase(), s.token1);
  }
  return Array.from(map.values());
}

function eq(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}
