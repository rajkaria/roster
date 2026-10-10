import { describe, expect, test } from "bun:test";
import prices from "../src/price/prices.json";
import { normaliseModelId, priceSession } from "../src/price/index.ts";

const M = 1_000_000;

describe("exact arithmetic", () => {
  test("Opus 5.5: input $4, output $20, cache read $0.20, cache write $5 per 1M", () => {
    const r = priceSession("claude-opus-5-5", {
      input: 1 * M,
      output: 100_000,
      cache_read: 2 * M,
      cache_write: 0.5 * M,
    });
    // 4 + 2 + 0.4 + 2.5
    expect(r.usd).toBeCloseTo(8.9, 10);
    expect(r.row_id).toBe("claude-opus-5-5");
  });

  test("Sonnet 5.5: input $2, output $10, cache read $0.10, cache write $2.50 per 1M", () => {
    const r = priceSession("claude-sonnet-5-5", {
      input: 250_000,
      output: 40_000,
      cache_read: 1 * M,
      cache_write: 400_000,
    });
    // 0.5 + 0.4 + 0.1 + 1.0
    expect(r.usd).toBeCloseTo(2.0, 10);
    expect(r.row_id).toBe("claude-sonnet-5-5");
  });

  test("GPT-6 Astra (Codex default): input $10, output $50, cached input $1 per 1M", () => {
    const r = priceSession("gpt-6-astra", { input: 300_000, output: 20_000, cache_read: 1 * M });
    // 3 + 1 + 1
    expect(r.usd).toBeCloseTo(5, 10);
    expect(r.row_id).toBe("gpt-6-astra");
  });

  test("zero counts contribute nothing", () => {
    expect(priceSession("claude-opus-5-5", { input: 0, output: 0 }).usd).toBe(0);
  });
});

describe("cache tokens", () => {
  test("cache read and write are priced separately from input", () => {
    const withCache = priceSession("claude-opus-5-5", { input: 0, output: 0, cache_read: M, cache_write: M });
    // 0.20 + 5
    expect(withCache.usd).toBeCloseTo(5.2, 10);
  });

  test("1-hour cache writes use the 1h rate", () => {
    const r = priceSession("claude-sonnet-5-5", { input: 0, output: 0, cache_write_1h: M });
    // $4 per 1M, not the $2.50 5-minute rate
    expect(r.usd).toBeCloseTo(4, 10);
  });

  test("1-hour cache writes are null where no 1h price is confirmed", () => {
    const r = priceSession("gpt-6-astra", { input: 0, output: 0, cache_write_1h: 1000 });
    expect(r.usd).toBeNull();
    expect(r.row_id).toBe("gpt-6-astra");
  });
});

describe("Haiku 5.5 long-prompt tier", () => {
  test("prompts up to 100,000 tokens use the short tier", () => {
    const r = priceSession("claude-haiku-5-5", { input: M, output: 0, prompt_tokens: 50_000 });
    expect(r.usd).toBeCloseTo(0.1, 10);
    expect(r.row_id).toBe("claude-haiku-5-5-short");
  });

  test("the boundary at exactly 100,000 is still short; 100,001 is long", () => {
    expect(priceSession("claude-haiku-5-5", { input: M, output: 0, prompt_tokens: 100_000 }).row_id).toBe(
      "claude-haiku-5-5-short",
    );
    const long = priceSession("claude-haiku-5-5", { input: M, output: 0, prompt_tokens: 100_001 });
    expect(long.row_id).toBe("claude-haiku-5-5-long");
    expect(long.usd).toBeCloseTo(0.5, 10);
  });

  test("a tiered model without prompt_tokens is null, never a guessed tier", () => {
    const r = priceSession("claude-haiku-5-5", { input: M, output: 0 });
    expect(r.usd).toBeNull();
  });
});

describe("unknown models", () => {
  test("a model with no row yields null and the unknown row", () => {
    const r = priceSession("claude-opus-4-8", { input: M, output: M });
    expect(r).toEqual({ usd: null, row_id: "unknown" });
  });

  test("an empty model id yields null", () => {
    expect(priceSession("", { input: 1, output: 1 })).toEqual({ usd: null, row_id: "unknown" });
  });
});

describe("Bedrock id normalisation", () => {
  test("global and version-suffixed Bedrock ids price like the first-party id", () => {
    const first = priceSession("claude-opus-5-5", { input: M, output: M });
    const bedrock = priceSession("global.anthropic.claude-opus-5-5-v1:0", { input: M, output: M });
    expect(bedrock.row_id).toBe("claude-opus-5-5");
    expect(bedrock.usd).toBe(first.usd);
    expect(bedrock.usd).toBeCloseTo(24, 10);
  });

  test("regional and multi-region profiles carry the 10% premium", () => {
    const r = priceSession("us.anthropic.claude-sonnet-5-5-v1:0", { input: M, output: 0 });
    // $2 * 1.1
    expect(r.usd).toBeCloseTo(2.2, 10);
    expect(r.row_id).toBe("claude-sonnet-5-5");
  });

  test("the anthropic. prefix alone is stripped and is not a premium", () => {
    const r = priceSession("anthropic.claude-haiku-5-5", { input: M, output: 0, prompt_tokens: 1 });
    expect(r.usd).toBeCloseTo(0.1, 10);
  });

  test("normalisation strips the bracket suffix, the date and the version", () => {
    expect(normaliseModelId("claude-opus-5-5[1m]")).toEqual({ base: "claude-opus-5-5", regional: false });
    expect(normaliseModelId("claude-sonnet-5-5-20260601")).toEqual({ base: "claude-sonnet-5-5", regional: false });
    expect(normaliseModelId("us.anthropic.claude-haiku-5-5-v1:0")).toEqual({ base: "claude-haiku-5-5", regional: true });
    expect(normaliseModelId("gpt-6-astra-2026-04-30")).toEqual({ base: "gpt-6-astra", regional: false });
  });

  test("a bracket suffix does not change the price", () => {
    expect(priceSession("claude-opus-5-5[1m]", { input: M, output: 0 }).usd).toBeCloseTo(4, 10);
  });
});

describe("price table integrity", () => {
  test("every priced row has a source URL and a checked_on date", () => {
    for (const row of prices.rows) {
      if (row.id === "unknown") continue;
      expect(row.source_url).toMatch(/^https:\/\//);
      expect(row.checked_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test("the unknown row has no prices", () => {
    const unknown = prices.rows.find((r) => r.id === "unknown");
    expect(unknown?.input).toBeNull();
    expect(unknown?.output).toBeNull();
  });
});
