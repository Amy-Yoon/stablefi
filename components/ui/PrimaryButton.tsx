"use client";

import { forwardRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// Toss primary palette pinned as literals so the CTA is never invisible
// even if Tailwind JIT drops a dynamic class during an HMR reload.
const PRIMARY = {
  bg:         "#3182F6",
  bgHover:    "#1B64DA",
  bgActive:   "#1957B9",
  disabledBg: "#E5E8EB",
  disabledFg: "#8B95A1",
  ghostBg:       "#F2F4F6",
  ghostBgHover:  "#E5E8EB",
  ghostFg:       "#4E5968",
} as const;

type Variant = "primary" | "ghost";
type Size = "md" | "lg";

interface PrimaryButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "disabled"> {
  loading?: boolean;
  disabled?: boolean;
  variant?: Variant;
  fullWidth?: boolean;
  size?: Size;
  leftIcon?: React.ReactNode;
}

export const PrimaryButton = forwardRef<HTMLButtonElement, PrimaryButtonProps>(
  function PrimaryButton(
    {
      children, loading, disabled, className,
      variant = "primary",
      fullWidth = true,
      size = "lg",
      leftIcon,
      style,
      onMouseEnter, onMouseLeave, onMouseDown, onMouseUp, onTouchStart, onTouchEnd,
      ...rest
    },
    ref,
  ) {
    const [hover, setHover] = useState(false);
    const [press, setPress] = useState(false);
    const isDisabled = !!disabled;

    let computedStyle: React.CSSProperties;
    if (isDisabled) {
      computedStyle = {
        backgroundColor: PRIMARY.disabledBg,
        color: PRIMARY.disabledFg,
        cursor: "not-allowed",
      };
    } else if (variant === "ghost") {
      computedStyle = {
        backgroundColor: hover ? PRIMARY.ghostBgHover : PRIMARY.ghostBg,
        color: PRIMARY.ghostFg,
        cursor: loading ? "wait" : "pointer",
        transform: press ? "scale(0.98)" : "scale(1)",
        transition: "background-color 120ms ease, transform 100ms ease",
      };
    } else {
      computedStyle = {
        backgroundColor:
          press ? PRIMARY.bgActive
          : hover ? PRIMARY.bgHover
          : PRIMARY.bg,
        color: "#FFFFFF",
        cursor: loading ? "wait" : "pointer",
        transform: press ? "scale(0.98)" : "scale(1)",
        transition: "background-color 120ms ease, transform 100ms ease",
      };
    }

    return (
      <button
        ref={ref}
        disabled={isDisabled || loading}
        style={{ ...computedStyle, ...style }}
        onMouseEnter={(e) => { setHover(true); onMouseEnter?.(e); }}
        onMouseLeave={(e) => { setHover(false); setPress(false); onMouseLeave?.(e); }}
        onMouseDown={(e) => { setPress(true); onMouseDown?.(e); }}
        onMouseUp={(e) => { setPress(false); onMouseUp?.(e); }}
        onTouchStart={(e) => { setPress(true); onTouchStart?.(e); }}
        onTouchEnd={(e) => { setPress(false); onTouchEnd?.(e); }}
        className={cn(
          "rounded-toss font-bold flex items-center justify-center gap-2 select-none",
          fullWidth && "w-full",
          size === "lg" ? "h-14 text-[15px]" : "h-12 text-[14px]",
          className,
        )}
        {...rest}
      >
        {loading && <Loader2 size={size === "lg" ? 16 : 15} className="animate-spin" />}
        {!loading && leftIcon}
        <span>{children}</span>
      </button>
    );
  },
);
