import { describe, expect, test } from "bun:test";
import { priceSession } from "../src/price/index.ts";

const M = 1_000_000;

describe("Haiku 5.5 with no per-request prompt size", () => {
  // Token shape of a real claude-haiku-5-5 session in reports/rajkaria__roster/sessions.json (T05).
  const shape = { input: 108, output: 63_216, cache_read: 2_269_989, cache_write: 170_100 };

  test("prices to a positive number on the short-context row, marked assumed-short", () => {
    const r = priceSession("claude-haiku-5-5", shape);
    const expected = (108 * 0.1 + 63_216 * 0.5 + 2_269_989 * 0.01 + 170_100 * 0.125) / M;
    expect(r.usd).toBeGreaterThan(0);
    expect(r.usd).toBeCloseTo(expected, 10);
    expect(r.row_id).toBe("claude-haiku-5-5-short");
    expect(r.tier).toBe("assumed-short");
    expect(r.lower_bound).toBe(true);
  });

  test("an exact prompt size is not marked assumed", () => {
    const r = priceSession("claude-haiku-5-5", { ...shape, prompt_tokens: 150_000 });
    expect(r.row_id).toBe("claude-haiku-5-5-long");
    expect(r.tier).toBeUndefined();
    expect(r.lower_bound).toBeUndefined();
  });

  test("a single-row model is not marked assumed", () => {
    expect(priceSession("claude-sonnet-5-5", { input: M, output: 0 }).tier).toBeUndefined();
  });

  test("an unknown model is still null", () => {
    expect(priceSession("no-such-model", shape).usd).toBeNull();
  });
});
