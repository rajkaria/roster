// DeepSeek time-of-day pricing (DESIGN.md §"Candidate generation").
// Source: https://api-docs.deepseek.com/quick_start/pricing
//
// Peak is 01:00–04:00 and 06:00–10:00 UTC, Monday through Friday. Every other hour is off-peak, weekends
// included. Off-peak is half the peak rate. The rows hold the PEAK rates:
//   input = cache miss, cache_read = cache hit, output = output.
// The page also excludes Chinese public holidays from peak. We keep no holiday calendar, so a holiday is
// priced at peak. That overstates its cost and never understates it.
//
// These rows live here, not in src/price/prices.json. priceSession() reads prices.json with no time-of-day
// rule, so a DeepSeek row there would bill off-peak runs at the peak rate.

import type { TokenCounts } from "./index.ts";

export const OFF_PEAK_FACTOR = 0.5;

export interface DeepSeekRow {
  id: string;
  model_pattern: string;
  /** Peak USD per 1M tokens. */
  input: number;
  output: number;
  cache_read: number;
  cache_write: null;
  source_url: string;
  checked_on: string;
}

const SOURCE_URL = "https://api-docs.deepseek.com/quick_start/pricing";
const CHECKED_ON = "2026-10-10";

export const DEEPSEEK_ROWS: DeepSeekRow[] = [
  {
    id: "deepseek-flash",
    model_pattern: "deepseek-flash",
    input: 0.3,
    output: 1.2,
    cache_read: 0.006,
    cache_write: null,
    source_url: SOURCE_URL,
    checked_on: CHECKED_ON,
  },
  {
    id: "deepseek-v4-pro",
    model_pattern: "deepseek-v4-pro",
    input: 1.32,
    output: 3.96,
    cache_read: 0.044,
    cache_write: null,
    source_url: SOURCE_URL,
    checked_on: CHECKED_ON,
  },
];

export type DeepSeekPrice = {
  /** null when a counted token type has no confirmed price. */
  usd: number | null;
  row_id: string;
  peak: boolean;
};

/** True during DeepSeek's peak window, judged in UTC. The end hour is exclusive: 04:00 and 10:00 are off-peak. */
export function isPeak(at: Date): boolean {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = at.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

/**
 * Prices one token-count record for a DeepSeek model at a given instant.
 * Returns null for a model that is not a DeepSeek row. Returns usd: null when a counted token type has no price.
 */
export function priceDeepSeek(model: string, tokens: TokenCounts, at: Date): DeepSeekPrice | null {
  const row = DEEPSEEK_ROWS.find((r) => r.model_pattern === model.trim().toLowerCase());
  if (row === undefined) return null;

  const peak = isPeak(at);
  const factor = peak ? 1 : OFF_PEAK_FACTOR;
  const counts: [number, number | null | undefined][] = [
    [tokens.input, row.input],
    [tokens.output, row.output],
    [tokens.cache_read ?? 0, row.cache_read],
    [tokens.cache_write ?? 0, row.cache_write],
  ];
  let usd = 0;
  for (const [count, price] of counts) {
    if (count === 0) continue;
    if (price === null || price === undefined) return { usd: null, row_id: row.id, peak };
    usd += (count * price) / 1_000_000;
  }
  return { usd: usd * factor, row_id: row.id, peak };
}
