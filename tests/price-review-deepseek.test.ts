import { describe, expect, test } from "bun:test";
import { priceSession } from "../src/price/index.ts";
import { priceDeepSeek } from "../src/price/deepseek.ts";
import { sessionCost } from "../src/score/index.ts";
import type { Session } from "../src/types.ts";

// Token shape copied from a real deepseek-flash session in reports/rajkaria__roster/sessions.json.
const REAL = { tokens_in: 35120, tokens_out: 14066, cache_read: 664448, cache_write: 0 };
const OFF_PEAK = "2026-10-11T05:11:20.700Z"; // Sunday
const PEAK = "2026-10-12T07:00:00.000Z"; // Monday 07:00 UTC

const session = (model: string, started_at: string, over: Partial<Session> = {}): Session => ({
  id: "s",
  repo: "r",
  checkpoint_id: "c",
  harness: "Claude Code",
  model,
  rules_hash: null,
  setup_id: null,
  ...REAL,
  cost_usd: null,
  n_user_prompts: 1,
  first_prompt: "",
  commit_sha: null,
  started_at,
  ended_at: started_at,
  files: [],
  entire_url: null,
  source: "branch",
  ...over,
});

describe("priceSession routes DeepSeek", () => {
  test("real deepseek-flash shape prices positive and matches priceDeepSeek", () => {
    const expected = priceDeepSeek(
      "deepseek-flash",
      { input: REAL.tokens_in, output: REAL.tokens_out, cache_read: REAL.cache_read },
      new Date(OFF_PEAK),
    );
    const r = priceSession(
      "deepseek-flash",
      { input: REAL.tokens_in, output: REAL.tokens_out, cache_read: REAL.cache_read, cache_write: 0 },
      OFF_PEAK,
    );
    expect(r.usd).toBeGreaterThan(0);
    expect(r.usd).toBe(expected!.usd!);
    expect(r.row_id).toBe("deepseek-flash");
  });

  test("peak costs twice off-peak", () => {
    const t = { input: 1000, output: 1000, cache_read: 1000 };
    expect(priceSession("deepseek-flash", t, PEAK).usd!).toBeCloseTo(2 * priceSession("deepseek-flash", t, OFF_PEAK).usd!, 12);
  });

  test("cache creation tokens are priced as cache misses", () => {
    const a = priceSession("deepseek-flash", { input: 100, output: 0, cache_write: 900 }, PEAK).usd;
    const b = priceSession("deepseek-flash", { input: 1000, output: 0 }, PEAK).usd;
    expect(a).toBe(b);
  });

  test("[1m] suffix and deepseek-v4-pro are routed", () => {
    const t = { input: 1000, output: 1000 };
    expect(priceSession("deepseek-flash[1m]", t, PEAK).usd).toBe(priceSession("deepseek-flash", t, PEAK).usd);
    const pro = priceSession("deepseek-v4-pro[1m]", t, PEAK);
    expect(pro.row_id).toBe("deepseek-v4-pro");
    expect(pro.usd).toBeGreaterThan(0);
  });

  test("a Date works as the timestamp", () => {
    const t = { input: 1000, output: 1000 };
    expect(priceSession("deepseek-flash", t, new Date(PEAK)).usd).toBe(priceSession("deepseek-flash", t, PEAK).usd);
  });

  test("no or invalid timestamp gives null, never a guess", () => {
    expect(priceSession("deepseek-flash", { input: 1000, output: 1000 }).usd).toBeNull();
    expect(priceSession("deepseek-flash", { input: 1000, output: 1000 }, "not a date").usd).toBeNull();
  });

  test("an unlisted deepseek model stays unknown", () => {
    expect(priceSession("deepseek-unknown", { input: 1, output: 1 }, PEAK)).toEqual({ usd: null, row_id: "unknown" });
  });

  test("Anthropic models are unchanged and ignore the timestamp", () => {
    const t = { input: 1000, output: 1000, cache_read: 1000 };
    const without = priceSession("claude-opus-5-5", t);
    expect(without.usd).toBeGreaterThan(0);
    expect(priceSession("claude-opus-5-5", t, PEAK)).toEqual(without);
  });
});

describe("sessionCost passes the session timestamp", () => {
  test("deepseek-flash session is priced at its started_at", () => {
    const peak = sessionCost(session("deepseek-flash", PEAK));
    const off = sessionCost(session("deepseek-flash", OFF_PEAK));
    expect(peak).toBeGreaterThan(0);
    expect(off).toBeGreaterThan(0);
    const expected = priceDeepSeek(
      "deepseek-flash",
      { input: REAL.tokens_in, output: REAL.tokens_out, cache_read: REAL.cache_read },
      new Date(OFF_PEAK),
    )!.usd;
    expect(off).toBe(expected!);
  });

  test("a recorded cost_usd still wins", () => {
    expect(sessionCost(session("deepseek-flash", PEAK, { cost_usd: 1.5 }))).toBe(1.5);
  });
});
