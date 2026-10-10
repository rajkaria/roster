import { describe, expect, test } from "bun:test";
import { buildSetupRows, renderReviewMarkdown, SETUP_ROW_KEYS } from "../src/review/export.ts";
import type { Outcome, Session } from "../src/types.ts";

const session = (id: string, cost: number | null): Session => ({
  id,
  repo: "r",
  checkpoint_id: id,
  harness: "Claude Code",
  model: "claude-haiku-5-5",
  rules_hash: null,
  setup_id: "S1",
  tokens_in: 1,
  tokens_out: 1,
  cache_read: 0,
  cache_write: 0,
  cost_usd: cost,
  n_user_prompts: 1,
  first_prompt: "",
  commit_sha: null,
  started_at: "2026-10-10T00:00:00Z",
  ended_at: "2026-10-10T00:00:01Z",
  files: [],
  entire_url: null,
  source: "branch",
});

const outcome = (id: string): Outcome => ({
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
});

describe("setup row spend with unpriced sessions", () => {
  test("one unpriced session gives spend_usd null and priced_sessions n-1", () => {
    const sessions = [session("a", 1.5), session("b", null), session("c", 0.25)];
    const [row] = buildSetupRows(sessions, sessions.map((s) => outcome(s.id)));
    expect(row!.spend_usd).toBeNull();
    expect(row!.priced_sessions).toBe(2);
    expect(row!.sessions).toBe(3);
  });

  test("all priced gives the sum", () => {
    const sessions = [session("a", 1.5), session("b", 0.25)];
    const [row] = buildSetupRows(sessions, sessions.map((s) => outcome(s.id)));
    expect(row!.spend_usd).toBeCloseTo(1.75, 12);
    expect(row!.priced_sessions).toBe(2);
  });

  test("a Haiku session over 100k total prompt makes the setup spend a lower bound, rendered with ≥", () => {
    const big = { ...session("a", 2.5), cache_read: 2_000_000 };
    const small = session("b", 0.5);
    const sessions = [big, small];
    const outcomes = sessions.map((s) => outcome(s.id));
    const setups = buildSetupRows(sessions, outcomes);
    expect(setups[0]!.spend_lower_bound).toBe(true);
    const review = { id: "x", repo: "o/r", created_at: "", has_entire_data: false, evidence_level: "A", label: "insufficient_data", suspect: null, setups };
    expect(renderReviewMarkdown({ review: review as never, note: "", sessions, outcomes, notes: [] })).toContain("≥ $3.00");
    expect(buildSetupRows([small], [outcome("b")])[0]!.spend_lower_bound).toBe(false);
  });

  test("priced_sessions is part of the row contract", () => {
    expect(SETUP_ROW_KEYS).toContain("priced_sessions");
  });

  test("review.md never renders unknown spend as $0.00", () => {
    const sessions = [session("a", 1.5), session("b", null)];
    const outcomes = sessions.map((s) => outcome(s.id));
    const setups = buildSetupRows(sessions, outcomes);
    const review = { id: "x", repo: "o/r", created_at: "", has_entire_data: false, evidence_level: "A", label: "insufficient_data", suspect: null, setups };
    const md = renderReviewMarkdown({ review: review as never, note: "", sessions, outcomes, notes: [] });
    expect(md).not.toContain("$0.00");
    expect(md).toContain("unknown (1/2 priced)");
  });
});
