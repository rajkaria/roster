import { describe, expect, test } from "bun:test";
import { priceSession } from "../src/price/index.ts";
import { aggregateBySetup, outcomesReport, sessionCost, sessionCostDetail, type ScoredOutcome } from "../src/score/index.ts";
import type { Session } from "../src/types.ts";

const M = 1_000_000;
const HAIKU = "claude-haiku-5-5";

describe("Haiku 5.5 tier boundary, per-request prompt size", () => {
  test("both sides of 100,000 price to the matching row and rate", () => {
    // Short: $0.10 input per 1M. Long: $0.50 input per 1M.
    const short = priceSession(HAIKU, { input: M, output: 0, prompt_tokens: 100_000 });
    const long = priceSession(HAIKU, { input: M, output: 0, prompt_tokens: 100_001 });
    expect(short.row_id).toBe("claude-haiku-5-5-short");
    expect(short.usd).toBeCloseTo(0.1, 10);
    expect(long.row_id).toBe("claude-haiku-5-5-long");
    expect(long.usd).toBeCloseTo(0.5, 10);
  });

  test("output and cache rates also switch with the tier", () => {
    const long = priceSession(HAIKU, { input: 0, output: M, cache_read: M, prompt_tokens: 150_000 });
    // $2.50 output + $0.05 cache read
    expect(long.usd).toBeCloseTo(2.55, 10);
  });
});

describe("Haiku 5.5 tier from a session's prompt bound", () => {
  test("a bound at or under 100,000 is certainly short-tier", () => {
    const r = priceSession(HAIKU, { input: M, output: 0, prompt_tokens_bound: 100_000 });
    expect(r.row_id).toBe("claude-haiku-5-5-short");
    expect(r.usd).toBeCloseTo(0.1, 10);
  });

  test("a bound over 100,000 could be either tier, so it is the short price flagged as a lower bound", () => {
    const r = priceSession(HAIKU, { input: M, output: 0, prompt_tokens_bound: 100_001 });
    expect(r.usd).toBeCloseTo(0.1, 10);
    expect(r.row_id).toBe("claude-haiku-5-5-short");
    expect(r.tier).toBe("assumed-short");
    expect(r.lower_bound).toBe(true);
  });

  test("an exact prompt size wins over the bound", () => {
    const r = priceSession(HAIKU, { input: M, output: 0, prompt_tokens: 100_001, prompt_tokens_bound: 500_000 });
    expect(r.row_id).toBe("claude-haiku-5-5-long");
  });
});

describe("sessionCost never reports a priced Haiku session as zero", () => {
  const base: Session = {
    id: "s1",
    repo: "r",
    checkpoint_id: "c1",
    harness: "Claude Code",
    model: HAIKU,
    rules_hash: null,
    setup_id: "setup-h",
    tokens_in: 1_000,
    tokens_out: 50_000,
    cache_read: 20_000,
    cache_write: 5_000,
    cost_usd: null,
    n_user_prompts: 1,
    first_prompt: "",
    commit_sha: null,
    started_at: "2026-10-10T00:00:00Z",
    ended_at: "2026-10-10T00:00:01Z",
    files: [],
    entire_url: null,
    source: "branch",
  };

  test("a short-tier Haiku session is priced from its tokens", () => {
    // 1k input at $0.10, 50k output at $0.50, 20k cache read at $0.01, 5k cache write at $0.125 (all per 1M)
    const expected = (1_000 * 0.1 + 50_000 * 0.5 + 20_000 * 0.01 + 5_000 * 0.125) / M;
    expect(sessionCost(base)).toBeCloseTo(expected, 12);
    expect(sessionCost(base)).toBeGreaterThan(0);
  });

  test("a Haiku session whose total prompt is over 100k is priced at the short tier as a lower bound", () => {
    const big = { ...base, cache_read: 2_000_000 };
    const expected = (1_000 * 0.1 + 50_000 * 0.5 + 2_000_000 * 0.01 + 5_000 * 0.125) / M;
    expect(sessionCost(big)).toBeCloseTo(expected, 12);
    expect(sessionCostDetail(big).lower_bound).toBe(true);
    expect(sessionCostDetail(base).lower_bound).toBe(false);
  });

  test("a session's own cost wins", () => {
    expect(sessionCost({ ...base, cost_usd: 0.42 })).toBe(0.42);
  });
});

describe("aggregate spend is null when any session is unpriced", () => {
  const row = (id: string, cost: number | null): ScoredOutcome => ({
    session_id: id,
    status: "too_young",
    survival: null,
    reverted: null,
    rework_human: null,
    rework_agent: null,
    unattended: null,
    tests_at_commit: null,
    difficulty: null,
    tercile: null,
    setup_id: "setup-h",
    commit_sha: null,
    cost_usd: cost,
    censored: "no_commit",
  });

  test("one null-cost session gives spend null and priced_sessions n-1", () => {
    const [a] = aggregateBySetup([row("a", 1.5), row("b", null), row("c", 0.25)]);
    expect(a!.sessions).toBe(3);
    expect(a!.cost_usd).toBeNull();
    expect(a!.priced_sessions).toBe(2);
    expect(a!.cost_unknown).toBe(1);
    expect(a!.cost_per_surviving_change).toBeNull();
  });

  test("all sessions priced gives the full sum and priced_sessions n", () => {
    const [a] = aggregateBySetup([row("a", 1.5), row("b", 0.25)]);
    expect(a!.cost_usd).toBeCloseTo(1.75, 12);
    expect(a!.priced_sessions).toBe(2);
    expect(a!.cost_unknown).toBe(0);
  });

  test("a setup with every session unpriced has spend null and priced_sessions 0", () => {
    const [a] = aggregateBySetup([row("a", null), row("b", null)]);
    expect(a!.cost_usd).toBeNull();
    expect(a!.priced_sessions).toBe(0);
  });

  test("a partly priced setup is left out of the report's cost totals", () => {
    const report = outcomesReport([row("a", 1.5), row("b", null)]);
    expect(report.cost_total_usd).toBe(0);
    expect(report.cost_by_setup).toEqual({});
    expect(report.cost_unknown.total).toBe(1);
  });
});
