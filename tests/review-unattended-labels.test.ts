import { describe, expect, test } from "bun:test";
import { scoreSession } from "../src/cli/review.ts";
import type { ParsedSession } from "../src/ingest/parse.ts";
import { buildSetupRows, summarizeSetups } from "../src/review/export.ts";
import type { Outcome, Session } from "../src/types.ts";

const session = (id: string, setup: string, hash: string | null, model = "claude-sonnet-5-5"): Session => ({
  id,
  repo: "r",
  checkpoint_id: "c",
  harness: "Claude Code",
  model,
  rules_hash: hash,
  setup_id: setup,
  tokens_in: 0,
  tokens_out: 0,
  cache_read: 0,
  cache_write: 0,
  cost_usd: 1,
  n_user_prompts: 1,
  first_prompt: "",
  commit_sha: "a",
  started_at: "",
  ended_at: "",
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

describe("too_young outcomes carry unattended", () => {
  const parsed = (n: number, sha: string | null): ParsedSession =>
    ({ ...session("s", "S", "h"), n_user_prompts: n, commit_sha: sha, usage_source: "x", model_source: "x" }) as unknown as ParsedSession;
  const ctx = { repo: "/nonexistent", head: "HEAD", headTime: 0 };

  test("a one-prompt session with no commit is unattended", () => {
    expect(scoreSession(parsed(1, null), ctx)).toMatchObject({ status: "too_young", unattended: true });
  });
  test("a multi-prompt session is not unattended", () => {
    expect(scoreSession(parsed(3, null), ctx)).toMatchObject({ status: "too_young", unattended: false });
  });
  test("an unknown prompt count stays null", () => {
    expect(scoreSession(parsed(Number.NaN, null), ctx).unattended).toBeNull();
  });
});

describe("setup labels", () => {
  test("two setups with the same harness and model get distinct labels", () => {
    const sessions = [session("a", "S1", "a1b2c3ffff"), session("b", "S2", "d4e5f6ffff")];
    const outcomes = [outcome("a"), outcome("b")];
    const labels = buildSetupRows(sessions, outcomes).map((r) => r.label);
    expect(labels).toEqual(["Claude Code · claude-sonnet-5-5 (rules a1b2c3)", "Claude Code · claude-sonnet-5-5 (rules d4e5f6)"]);
    expect(summarizeSetups(sessions, outcomes).map((r) => r.label)).toEqual(labels);
  });

  test("a unique setup keeps its plain label", () => {
    const sessions = [session("a", "S1", "a1b2c3ffff"), session("b", "S2", "d4e5f6ffff", "claude-opus-5-5")];
    const labels = buildSetupRows(sessions, [outcome("a"), outcome("b")]).map((r) => r.label);
    expect(labels).toEqual(["Claude Code · claude-sonnet-5-5", "Claude Code · claude-opus-5-5"]);
  });
});
