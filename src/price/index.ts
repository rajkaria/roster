import rows from "./prices.json";

// Prices are USD per 1M tokens, taken from src/price/prices.json.
// A null price means "not confirmed", so a session that uses it has a null cost. We never guess.

export type PriceRow = {
  id: string;
  model_pattern: string;
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  cache_write_1h?: number | null;
  max_prompt_tokens?: number;
  min_prompt_tokens?: number;
  source_url: string | null;
  checked_on: string;
};

export type TokenCounts = {
  /** Uncached input tokens. For OpenAI-style usage, subtract cached_input_tokens first. */
  input: number;
  /** Output tokens. For OpenAI-style usage, add reasoning_output_tokens (billed as output). */
  output: number;
  cache_read?: number;
  /** 5-minute cache writes. */
  cache_write?: number;
  /** 1-hour cache writes. Only priced where the row has cache_write_1h. */
  cache_write_1h?: number;
  /**
   * Total input of one request: input + cache_read + cache_write + cache_write_1h.
   * Tiered rows (Haiku 5.5 above 100k tokens) need it, so pass a single request's counts.
   * Sum the per-request results for a session.
   */
  prompt_tokens?: number;
};

export type PriceResult = {
  usd: number | null;
  row_id: string;
};

const ROWS = rows.rows as PriceRow[];

// Bedrock regional and multi-region endpoints cost 10% more than global ones
// (platform.claude.com/docs/en/about-claude/pricing, "Regional and multi-region endpoint pricing").
const REGIONAL_PREFIXES = new Set(["us", "eu", "jp", "au", "apac"]);
const REGIONAL_PREMIUM = 1.1;

/**
 * Reduces a model id to its base name, e.g.
 *   "us.anthropic.claude-opus-5-5-v1:0" -> { base: "claude-opus-5-5", regional: true }
 *   "claude-opus-5-5[1m]"               -> { base: "claude-opus-5-5", regional: false }
 *   "global.anthropic.claude-haiku-5-5" -> { base: "claude-haiku-5-5", regional: false }
 *   "claude-sonnet-5-5-20260601"        -> { base: "claude-sonnet-5-5", regional: false }
 */
export function normaliseModelId(model: string): { base: string; regional: boolean } {
  let id = model.trim().toLowerCase();
  id = id.replace(/\[[^\]]*\]$/, "");
  let regional = false;
  for (;;) {
    const m = id.match(/^([a-z]+)\./);
    if (!m) break;
    const prefix = m[1] ?? "";
    if (prefix === "global") regional = false;
    else if (REGIONAL_PREFIXES.has(prefix)) regional = true;
    else if (prefix !== "anthropic") break;
    id = id.slice(m[0].length);
  }
  id = id.replace(/-v\d+(:\d+)?$/, "");
  id = id.replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return { base: id, regional };
}

function pickRow(base: string, promptTokens: number | undefined): PriceRow | "ambiguous" | undefined {
  const candidates = ROWS.filter((r) => r.model_pattern === base);
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  if (promptTokens === undefined) return "ambiguous";
  return candidates.find(
    (r) =>
      (r.max_prompt_tokens === undefined || promptTokens <= r.max_prompt_tokens) &&
      (r.min_prompt_tokens === undefined || promptTokens >= r.min_prompt_tokens),
  );
}

/** Prices one token-count record for a model. Returns usd: null when the model or price is unknown. */
export function priceSession(model: string, tokens: TokenCounts): PriceResult {
  const { base, regional } = normaliseModelId(model);
  const row = pickRow(base, tokens.prompt_tokens);
  if (row === undefined) return { usd: null, row_id: "unknown" };
  if (row === "ambiguous") return { usd: null, row_id: "unknown" };

  const counts: [number, number | null | undefined][] = [
    [tokens.input, row.input],
    [tokens.output, row.output],
    [tokens.cache_read ?? 0, row.cache_read],
    [tokens.cache_write ?? 0, row.cache_write],
    [tokens.cache_write_1h ?? 0, row.cache_write_1h],
  ];
  let usd = 0;
  for (const [count, price] of counts) {
    if (count === 0) continue;
    if (price === null || price === undefined) return { usd: null, row_id: row.id };
    usd += (count * price) / 1_000_000;
  }
  return { usd: regional ? usd * REGIONAL_PREMIUM : usd, row_id: row.id };
}
