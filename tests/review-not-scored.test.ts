// A session whose scoring failed (git timed out or errored) is `not_scored`, never passed off as `too_young`.
// Found 13 Oct: a cold review timed out on all 73 mature sessions of a repo and reported "0 mature", because each
// failure was recorded as too young.
import { describe, expect, test } from "bun:test";
import { settleOutcome } from "../src/cli/review.ts";
import type { ParsedSession } from "../src/ingest/parse.ts";
import { buildSetupRows } from "../src/review/export.ts";
import type { Outcome, Session } from "../src/types.ts";

const session = (id: string, prompts: number): ParsedSession =>
  ({
    id,
    repo: "r",
    checkpoint_id: "c",
    harness: "Claude Code",
    model: "claude-sonnet-5-5",
    rules_hash: "h",
    setup_id: "S",
    tokens_in: 0,
    tokens_out: 0,
    cache_read: 0,
    cache_write: 0,
    cost_usd: 1,
    n_user_prompts: prompts,
    first_prompt: "",
    commit_sha: "a",
    started_at: "",
    ended_at: "",
    files: [],
    entire_url: null,
    source: "branch",
    usage_source: "metadata",
    model_source: "metadata",
  }) as ParsedSession;

const mature: Outcome = {
  session_id: "m",
  status: "mature",
  survival: 1,
  reverted: false,
  rework_human: 0,
  rework_agent: 0,
  unattended: true,
  tests_at_commit: false,
  difficulty: null,
  tercile: null,
};

describe("settleOutcome", () => {
  test("a scoring error becomes not_scored with null metrics and the reason", () => {
    const { outcome, failure } = settleOutcome(session("s1", 1), new Error("git blame CHANGELOG.md timed out"));
    expect(outcome).toMatchObject({
      session_id: "s1",
      status: "not_scored",
      survival: null,
      reverted: null,
      rework_human: null,
      rework_agent: null,
      unattended: true,
    });
    expect(failure).toBe("s1: git blame CHANGELOG.md timed out");
  });

  test("a multi-prompt failed session is not unattended", () => {
    expect(settleOutcome(session("s2", 3), new Error("x")).outcome.unattended).toBe(false);
  });

  test("a scored outcome passes through with no failure", () => {
    expect(settleOutcome(session("m", 1), mature)).toEqual({ outcome: mature });
  });
});

test("setup rows count a not_scored session as neither mature nor too young", () => {
  const sessions: Session[] = [session("m", 1), session("s1", 1)];
  const outcomes = [mature, settleOutcome(session("s1", 1), new Error("timed out")).outcome];
  const [row] = buildSetupRows(sessions, outcomes);
  expect(row!.sessions).toBe(2);
  expect(row!.mature_sessions).toBe(1);
});
