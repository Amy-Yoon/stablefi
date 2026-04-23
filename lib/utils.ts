import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { formatUnits, parseUnits } from "viem";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ── Token amount formatting ───────────────────────────────────────────────────
// Default display for any token balance: "<number> <symbol>"
// Keeps 4 significant digits for small amounts, ko-KR grouping for large ones.
export function formatTokenAmount(
  raw: bigint | number,
  decimals: number,
  opts: { maxFraction?: number } = {}
): string {
  const maxFraction = opts.maxFraction ?? pickFractionDigits(decimals);
  const asString =
    typeof raw === "bigint" ? formatUnits(raw, decimals) : String(raw);
  const n = Number(asString);
  if (!isFinite(n)) return "0";
  if (n === 0) return "0";
  if (n > 0 && n < 1 / 10 ** maxFraction) return `< ${1 / 10 ** maxFraction}`;
  return n.toLocaleString("ko-KR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFraction,
  });
}

export function formatToken(
  raw: bigint | number,
  symbol: string,
  decimals: number,
  opts?: { maxFraction?: number }
): string {
  return `${formatTokenAmount(raw, decimals, opts)} ${symbol}`;
}

// Decide how many decimals to show depending on token decimals.
// 18-decimals → 4, 8-decimals (BTC) → 6, 6-decimals (stables) → 2
function pickFractionDigits(tokenDecimals: number): number {
  if (tokenDecimals >= 18) return 4;
  if (tokenDecimals >= 8)  return 6;
  if (tokenDecimals >= 6)  return 2;
  return Math.min(tokenDecimals, 4);
}

// ── WKRC (reference currency) ─────────────────────────────────────────────────
// Displayed as whole-won "12,450 WKRC" — no decimals, no ₩ prefix.
export function formatWKRC(raw: bigint | number, decimals: number = 18): string {
  const asString =
    typeof raw === "bigint" ? formatUnits(raw, decimals) : String(raw);
  const n = Number(asString);
  if (!isFinite(n)) return "0 WKRC";
  if (n === 0) return "0 WKRC";
  if (n > 0 && n < 1) return `< 1 WKRC`;
  return `${Math.round(n).toLocaleString("ko-KR")} WKRC`;
}

// Accept a human string like "1,234.56" and convert to raw bigint with decimals.
export function parseTokenInput(value: string, decimals: number): bigint {
  const cleaned = value.replace(/,/g, "").trim();
  if (!cleaned) return 0n;
  try {
    return parseUnits(cleaned as `${number}`, decimals);
  } catch {
    return 0n;
  }
}

// ── Generic helpers ───────────────────────────────────────────────────────────
export function shortenAddress(addr: string): string {
  if (!addr) return "";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// Convert a raw bigint (with decimals) to a plain JS number for display math.
// Use only for UI — do NOT use for on-chain value math (precision loss).
export function rawToNumber(raw: bigint | undefined, decimals: number): number {
  if (raw === undefined) return 0;
  return Number(formatUnits(raw, decimals));
}
