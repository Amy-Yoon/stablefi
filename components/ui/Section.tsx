import type { ReactNode } from "react";

// The single rule for section layout app-wide:
//   • Section title sits ABOVE the card (never inside)
//   • Optional action (link / button) aligned right on the same row
//   • Card content (typically `bg-white rounded-toss-lg`) is passed as children
//
// Every screen should compose using this so the "title + grid" pattern
// is visually identical on every page.

interface SectionProps {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Section({ title, action, children, className }: SectionProps) {
  return (
    <section className={className}>
      {(title || action) && (
        <div className="flex items-center justify-between mb-2 px-1 min-h-[22px]">
          {title ? (
            <h2 className="text-[14px] font-bold text-neutral-900">{title}</h2>
          ) : <span />}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
