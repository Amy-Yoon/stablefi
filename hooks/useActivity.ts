"use client";

import { useQuery } from "@tanstack/react-query";
import type { ExplorerTx } from "@/components/activity/ActivityRow";
import {
  getPendingTxs,
  prunePendingTxs,
  readWalletBlockNumber,
} from "@/lib/pendingTxs";

// ── 공용 활동 쿼리 훅 ──────────────────────────────────────────────────────
// 홈 위젯 / 홈 Section 래퍼 / /activity 페이지가 전부 같은 queryKey를
// 공유하는데, 각자 queryFn을 따로 정의하면 React Query가 "같은 key + 다른
// 옵션" 경고를 내고 레이스 상태로 빠진다. 실제 증상:
//   - Home의 빈 상태 체크(RecentActivitySection)는 plain fetch로 돌리고,
//   - Widget은 extraHashes + clientLatest 힌트 + readWalletBlockNumber 대기
//   - React Query는 둘 중 먼저 subscribe 된 쪽 queryFn만 사용
//   - 위젯이 이기면 readWalletBlockNumber가 hang → permanent loading
//   - Section이 이기면 위젯이 원하는 extra param이 안 붙어서 다른 동작
// 한 곳에 모아서 일관된 queryFn 하나만 쓰게 한다.
//
// 호출 쪽은 그냥 이 훅 결과를 쓰면 되고, 캐시는 전부 같은 key 하나에 누적됨.

export type ActivityResponse = {
  items: ExplorerTx[];
  source: string;
  error?: string;
  debug?: Record<string, unknown>;
};

/**
 * @param address - 사용자 지갑 주소. falsy면 쿼리는 실행되지 않고 undefined 반환.
 * @param limit   - 서버에 요청할 최대 건수. 홈 위젯은 20, /activity 페이지는 100.
 *                  같은 key를 공유하기 때문에 실제 호출은 한 번이지만, 파라미터는
 *                  먼저 subscribe 된 쪽이 정해진다 (관측 상 문제 없음 — 서버가
 *                  limit 만큼 잘라 주니 초과분은 숨기고 쓰면 됨).
 */
export function useActivity(address: string | null | undefined, limit = 20) {
  return useQuery<ActivityResponse>({
    queryKey: ["activity", (address ?? "").toLowerCase()],
    queryFn: async () => {
      if (!address) {
        // enabled guard로도 막히지만 방어적으로 한 번 더 체크.
        return { items: [], source: "disabled" };
      }
      // 로컬에 기록된 방금 낸 tx 해시를 같이 태움. 서버 getLogs 스캐너가
      // 체인 tip 보다 뒤쳐져도 receipt 직접 조회로 뜸.
      const pending = getPendingTxs(address).map((t) => t.hash);
      const extra = pending.length > 0 ? `&extraHashes=${pending.join(",")}` : "";

      // 지갑 provider의 최신 블록을 힌트로. readWalletBlockNumber에 timeout
      // 레이스가 걸려있어서 MM circuit breaker 상태에서도 1.5s 안에 0n로
      // 떨어지고 그 뒤 fetch가 정상 진행됨.
      const walletBlock = await readWalletBlockNumber();
      const hint = walletBlock > 0n ? `&clientLatest=${walletBlock.toString()}` : "";

      const res = await fetch(
        `/api/activity?address=${address}&limit=${limit}${extra}${hint}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ActivityResponse;

      // 서버가 이미 찾아준 해시는 로컬 캐시에서 제거.
      if (address && json.items?.length) {
        prunePendingTxs(
          address,
          json.items.map((it) => it.hash),
        );
      }
      return json;
    },
    enabled: !!address,
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 60,
  });
}
