"use client";

import { cn } from "@/lib/utils";

// ── AmountPresets ────────────────────────────────────────────────────────────
// 바꾸기 / 맡기기 / 꺼내기 세 곳에서 공용으로 쓰는 "25 · 50 · 75 · 최대" pill.
// 예전에는 각 화면마다 UI가 달라서 (swap=최대만, 맡기기=없음, 꺼내기=슬라이더+%)
// 사용자가 같은 역할인데 왜 다 다르냐고 혼란스러워했음. 이 컴포넌트 하나를
// 돌려 쓰면 자동으로 통일됨.
//
// prop 계약:
//   - onPercent(25|50|75)  → 해당 비율로 설정
//   - onMax()              → 100%(여유분 있으면 여유분 뺀 최대). onMax가
//                            주어지면 "최대" 버튼은 그걸 호출, 아니면
//                            onPercent(100).
//   - active               → 현재 활성화된 비율(숫자). 정확히 일치할 때 강조.
//     꺼내기처럼 슬라이더와 연결된 경우 유용.
//   - size="sm" | "md"     → 바꾸기 balance line에는 sm, 꺼내기 카드는 md.

export interface AmountPresetsProps {
  onPercent?: (pct: number) => void;
  onMax?: () => void;
  active?: number;
  size?: "sm" | "md";
  className?: string;
}

const PERCENTS: Array<{ pct: number; label: string }> = [
  { pct: 25,  label: "25%" },
  { pct: 50,  label: "50%" },
  { pct: 75,  label: "75%" },
  { pct: 100, label: "최대" },
];

export function AmountPresets({
  onPercent,
  onMax,
  active,
  size = "sm",
  className,
}: AmountPresetsProps) {
  const sm = size === "sm";
  return (
    <div
      className={cn(
        "flex items-center",
        sm ? "gap-1 ml-1" : "gap-2",
        className,
      )}
    >
      {PERCENTS.map(({ pct, label }) => {
        const isActive = active === pct;
        const handle = () => {
          if (pct === 100 && onMax) { onMax(); return; }
          onPercent?.(pct);
        };
        return (
          <button
            key={pct}
            type="button"
            onClick={handle}
            className={cn(
              "font-bold tabular-nums press transition-colors",
              sm
                ? "px-2 py-0.5 rounded-md text-[11px]"
                : "flex-1 py-2 rounded-lg text-[12px]",
              isActive
                ? "bg-toss-500 text-white"
                : sm
                  ? "text-toss-500 bg-toss-50 hover:bg-toss-100"
                  : "bg-white text-neutral-700 hover:bg-neutral-100",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
