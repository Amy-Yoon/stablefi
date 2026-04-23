import type { ReactNode } from "react";

// Single source of truth for page-level headings app-wide.
//
// Every route-level page (home, swap, pools, me) starts with this component
// so the title/desc typography, spacing, and layout rhythm stay identical.
// Don't reimplement these sizes inline — use this.

interface PageHeaderProps {
  title: ReactNode;
  desc?: ReactNode;
  /** Right-aligned action — e.g. hide-balance toggle, settings button. */
  action?: ReactNode;
}

export function PageHeader({ title, desc, action }: PageHeaderProps) {
  return (
    <div className="pt-2">
      <div className="flex items-start justify-between gap-3">
        <h1 className="text-[26px] font-black text-neutral-900 tracking-tight leading-tight">
          {title}
        </h1>
        {action && <div className="shrink-0 pt-1.5">{action}</div>}
      </div>
      {desc && (
        <p className="text-[14px] text-neutral-500 mt-1">{desc}</p>
      )}
    </div>
  );
}
