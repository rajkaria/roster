const MINUS = "−";

export function usd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "n/a";
  const s = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  // Avoid "−$0.00" for values that round to zero.
  return n < 0 && s !== "0.00" ? `${MINUS}$${s}` : `$${s}`;
}

export function pct(share: number | null, digits = 1): string {
  if (share === null || !Number.isFinite(share)) return "n/a";
  return `${(share * 100).toFixed(digits)}%`;
}

export function pValue(p: number, n: number): string {
  const base = p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(3)}`;
  return p >= 0.05 ? `${base} (not significant at n = ${n})` : base;
}
