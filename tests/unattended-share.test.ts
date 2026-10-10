import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSetupRows, validateReview } from "../src/review/export.ts";
import type { Outcome, Review, Session, SetupRow } from "../src/types.ts";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli.ts");
const MAKE_FIXTURE = join(import.meta.dir, "fixtures", "make-fixture.ts");

const session = (id: string, prompts: number): Session => ({
  id,
  repo: "r",
  checkpoint_id: id,
  harness: "Claude Code",
  model: "claude-sonnet-5-5",
  rules_hash: null,
  setup_id: "S1",
  tokens_in: 1,
  tokens_out: 1,
  cache_read: 0,
  cache_write: 0,
  cost_usd: 1,
  n_user_prompts: prompts,
  first_prompt: "",
  commit_sha: "a",
  started_at: "2026-10-10T00:00:00Z",
  ended_at: "2026-10-10T00:00:01Z",
  files: [],
  entire_url: null,
  source: "branch",
});

/** A too_young outcome keeps its unattended flag (it needs no commit age); metrics stay null. */
const outcome = (s: Session, mature: boolean): Outcome => ({
  session_id: s.id,
  status: mature ? "mature" : "too_young",
  survival: mature ? 1 : null,
  reverted: mature ? false : null,
  rework_human: mature ? 0 : null,
  rework_agent: mature ? 0 : null,
  unattended: Number.isFinite(s.n_user_prompts) ? s.n_user_prompts === 1 : null,
  tests_at_commit: null,
  difficulty: null,
  tercile: null,
});

/** 10 sessions: 2 mature, 8 too young; 9 of them needed exactly one prompt. */
function tenSessions(): { sessions: Session[]; outcomes: Outcome[] } {
  const sessions = Array.from({ length: 10 }, (_, i) => session(`s${i}`, i === 9 ? 3 : 1));
  const outcomes = sessions.map((s, i) => outcome(s, i < 2));
  return { sessions, outcomes };
}

/** Wraps setup rows in a Review that carries every contract field, so validateReview judges the rows. */
const reviewWith = (setups: SetupRow[]): Review => ({
  id: "r",
  repo: "fixture",
  created_at: "2026-10-10T00:00:00Z",
  generated_at: "2026-10-10T00:00:00Z",
  has_entire_data: true,
  setups,
  label: "insufficient_data",
  suspect: null,
  odds_ratio: null,
  ci95: null,
  p_value: null,
  evidence_level: "A",
});

describe("unattended share is over all sessions with a known prompt count", () => {
  test("2 mature and 8 too young with 9 one-prompt sessions gives 0.9, and the review validates", () => {
    const { sessions, outcomes } = tenSessions();
    const [row] = buildSetupRows(sessions, outcomes);
    expect(row!.mature_sessions).toBe(2);
    expect(row!.unattended).toBe(0.9);
    expect(validateReview(reviewWith([row!]))).toEqual([]);
  });

  test("survival, reverted and rework stay over the mature sessions only", () => {
    const { sessions, outcomes } = tenSessions();
    const [row] = buildSetupRows(sessions, outcomes);
    expect(row).toMatchObject({ survival: 1, reverted: 0, rework_human: 0 });
  });

  test("a setup whose sessions all lack a known prompt count has unattended null", () => {
    const sessions = [session("a", Number.NaN), session("b", Number.NaN)];
    const outcomes = sessions.map((s) => ({ ...outcome(s, false), unattended: null }));
    const [row] = buildSetupRows(sessions, outcomes);
    expect(row!.unattended).toBeNull();
    expect(validateReview(reviewWith([row!]))).toEqual([]);
  });

  test("a setup with no mature session but known prompt counts gives a share, and still validates", () => {
    const sessions = [session("a", 1), session("b", 2)];
    const [row] = buildSetupRows(sessions, sessions.map((s) => outcome(s, false)));
    expect(row).toMatchObject({ mature_sessions: 0, unattended: 0.5 });
    expect(validateReview(reviewWith([row!]))).toEqual([]);
  });

  test("a share above 1 is still rejected by the validator", () => {
    const { sessions, outcomes } = tenSessions();
    const [row] = buildSetupRows(sessions, outcomes);
    expect(validateReview(reviewWith([{ ...row!, unattended: 1.2 }]))).toContain("setups[0].unattended must be null or a number in [0, 1]");
  });
});

describe("the T01 fixture review validates end to end", () => {
  let work: string;
  let outDir: string;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "roster-unattended-share-"));
    const repo = join(work, "fixture");
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", NEATLOGS_API_KEY: "" };
    const built = Bun.spawnSync([process.execPath, MAKE_FIXTURE, repo, "--scenario", "basic"], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env });
    if (built.exitCode !== 0) throw new Error(`make-fixture failed: ${built.stderr.toString()}`);
    outDir = join(work, "reports", "fixture");
    const r = Bun.spawnSync([process.execPath, CLI, "review", repo, "--observational", "--out", outDir, "--cache", join(work, "cache")], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    if (r.exitCode !== 0) throw new Error(`roster review failed: ${r.stderr.toString()}`);
  }, 120_000);

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  test("review.json validates and every unattended share is in [0, 1] or null", () => {
    const review = JSON.parse(readFileSync(join(outDir, "review.json"), "utf8")) as Review;
    expect(validateReview(review)).toEqual([]);
    for (const row of review.setups) expect(row.unattended === null || (row.unattended >= 0 && row.unattended <= 1)).toBe(true);
  });
});
