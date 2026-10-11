import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verdict } from "../src/cli/review.ts";
import { validateReview, writeReview } from "../src/review/export.ts";
import type { Outcome, Review, Session, Tercile } from "../src/types.ts";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli.ts");
const MAKE_FIXTURE = join(import.meta.dir, "fixtures", "make-fixture.ts");

/** Runs the real CLI in a subprocess with Neatlogs forced off. */
function runCli(args: string[]) {
  const p = Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NEATLOGS_API_KEY: "" },
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

let work: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "roster-review-suspect-"));
}, 120_000);

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

// Hand-built sessions and outcomes for the statistics. They are not Entire payloads, so they are not fixtures;
// the CLI tests below use fixtures built from the redacted samples.
const session = (id: string, setup: string): Session => ({
  id,
  repo: "r",
  checkpoint_id: "c",
  harness: "Claude Code",
  model: "claude-opus-5-5",
  rules_hash: "h",
  setup_id: setup,
  tokens_in: 0,
  tokens_out: 0,
  cache_read: 0,
  cache_write: 0,
  cost_usd: 1,
  n_user_prompts: 1,
  first_prompt: "do it",
  commit_sha: "a",
  started_at: "",
  ended_at: "",
  files: [],
  entire_url: null,
  source: "branch",
});

const mature = (id: string, tercile: Tercile, bad: boolean): Outcome => ({
  session_id: id,
  status: "mature",
  survival: bad ? 0 : 1,
  reverted: bad,
  rework_human: 0,
  rework_agent: 0,
  unattended: true,
  tests_at_commit: null,
  difficulty: null,
  tercile,
});

/**
 * Builds sessions and outcomes for setups from a table: for each setup, the number of sessions and the number
 * of bad ones in each tercile, e.g. { X: { 1: [10, 8], 2: [10, 8], 3: [10, 8] } }.
 */
function cohort(table: Record<string, Record<number, [number, number]>>) {
  const sessions: Session[] = [];
  const outcomes: Outcome[] = [];
  for (const [setup, byTercile] of Object.entries(table)) {
    for (const [t, [n, bad]] of Object.entries(byTercile)) {
      for (let i = 0; i < n; i++) {
        const id = `${setup}-${t}-${i}`;
        sessions.push(session(id, setup));
        outcomes.push(mature(id, Number(t) as Tercile, i < bad));
      }
    }
  }
  return { sessions, outcomes };
}

/** The Review type around a verdict, so validateReview can check the fields the verdict fills in. */
const asReview = (v: ReturnType<typeof verdict>): Review => ({
  id: "r",
  repo: "x",
  created_at: "2026-10-11T00:00:00.000Z",
  generated_at: "2026-10-11T00:00:00.000Z",
  has_entire_data: true,
  setups: [],
  label: v.label,
  suspect: v.suspect,
  odds_ratio: v.odds_ratio,
  ci95: v.ci95,
  p_value: v.p_value,
  evidence_level: "A",
});

describe("verdict on constructed cohorts", () => {
  test("a true effect is named: X's bad outcomes are matched against the same tercile", () => {
    // X is bad in 8 of 10 sessions in every tercile; the rest are bad in 2 of 10. The effect is the same at every
    // difficulty, so the matched odds ratio is large and its p is far below 0.05.
    const { sessions, outcomes } = cohort({
      X: { 1: [10, 8], 2: [10, 8], 3: [10, 8] },
      Y: { 1: [10, 2], 2: [10, 2], 3: [10, 2] },
    });
    const v = verdict(sessions, outcomes);
    expect(v.label).toBe("suspect");
    expect(v.suspect).toBe("X");
    expect(v.p_value).toBeLessThan(0.05);
    expect(v.odds_ratio).toBeGreaterThan(1);
    expect(v.ci95![0]).toBeGreaterThan(1);
    expect(v.note).toContain("Setup X is flagged");
    expect(validateReview(asReview(v))).toEqual([]);

    // The same verdict, written the way runReview writes it, lands in review.json.
    const dir = join(work, "true-effect");
    writeReview(dir, { review: asReview(v), note: v.note, sessions, outcomes, notes: [v.reason] });
    const written = JSON.parse(readFileSync(join(dir, "review.json"), "utf8")) as Review;
    expect(written).toMatchObject({ label: "suspect", suspect: "X" });
    expect(written.p_value).toBeLessThan(0.05);
    expect(validateReview(written)).toEqual([]);
  });

  test("a confound is not named: X's raw rate is high only because it got the hard tasks", () => {
    // Raw bad rate: X 6 of 10, the rest 3 of 9. Matched by tercile, X's only hard-task sessions are as bad as
    // Y's, and X's one easy session is good, so the matched odds ratio is 1.
    const { sessions, outcomes } = cohort({
      X: { 1: [1, 0], 3: [9, 6] },
      Y: { 1: [8, 0], 3: [3, 2] },
    });
    const v = verdict(sessions, outcomes);
    expect(v.label).not.toBe("suspect");
    expect(v.suspect).toBeNull();
    expect(v.odds_ratio).toBeCloseTo(1, 5);
    expect(v.note).toContain("No setup is flagged");
    expect(validateReview(asReview(v))).toEqual([]);
  });

  test("too few mature sessions give insufficient data, with the reason in plain words", () => {
    const { sessions, outcomes } = cohort({
      X: { 1: [3, 3], 2: [3, 3] },
      Y: { 1: [3, 0], 2: [3, 0] },
    });
    const v = verdict(sessions, outcomes);
    expect(v).toMatchObject({ label: "insufficient_data", suspect: null, odds_ratio: null, ci95: null, p_value: null });
    expect(v.reason).toBe("no setup has ≥ 8 mature sessions");
    expect(v.note).toBe("No suspect call: no setup has ≥ 8 mature sessions.");
    expect(validateReview(asReview(v))).toEqual([]);
  });

  test("too-young outcomes and sessions without a setup never count toward the call", () => {
    // 7 mature sessions for X, one short. Twenty more would make 27 if the young ones or the unset ones counted.
    const { sessions, outcomes } = cohort({ X: { 1: [7, 7] } });
    const young: Outcome[] = Array.from({ length: 20 }, (_, i) => ({
      ...mature(`young-${i}`, 1, true),
      status: "too_young",
      survival: null,
      reverted: null,
      rework_human: null,
      rework_agent: null,
      tercile: null,
    }));
    const unset: Session[] = Array.from({ length: 20 }, (_, i) => ({ ...session(`unset-${i}`, "X"), setup_id: null }));
    const unsetOutcomes = unset.map((s) => mature(s.id, 1, true));
    expect(verdict([...sessions, ...unset], [...outcomes, ...young, ...unsetOutcomes]).label).toBe("insufficient_data");
  });
});

describe("roster review on the fixtures", () => {
  let confound: ReturnType<typeof runCli>;
  let basic: ReturnType<typeof runCli>;
  let confoundOut: string;
  let basicOut: string;

  beforeAll(() => {
    const repos: Record<string, string> = { confound: join(work, "confound"), basic: join(work, "basic") };
    for (const [scenario, dir] of Object.entries(repos)) {
      const built = Bun.spawnSync([process.execPath, MAKE_FIXTURE, dir, "--scenario", scenario], { stdout: "pipe", stderr: "pipe" });
      if (built.exitCode !== 0) throw new Error(`make-fixture failed: ${built.stderr.toString()}`);
    }
    confoundOut = join(work, "out-confound");
    basicOut = join(work, "out-basic");
    confound = runCli(["review", repos.confound!, "--observational", "--out", confoundOut, "--cache", join(work, "cache")]);
    basic = runCli(["review", repos.basic!, "--observational", "--out", basicOut, "--cache", join(work, "cache")]);
  }, 300_000);

  test("the confound fixture is not flagged: X has the highest raw rate but its matched odds ratio is near 1", () => {
    expect(confound.code).toBe(0);
    const review = JSON.parse(readFileSync(join(confoundOut, "review.json"), "utf8")) as Review;
    expect(review.label).not.toBe("suspect");
    expect(review.suspect).toBeNull();
    expect(review.label).toBe("no_suspect");
    expect(validateReview(review)).toEqual([]);
    expect(review.odds_ratio).not.toBeNull();
  });

  test("the confound fixture's review.md says why no setup is flagged", () => {
    const md = readFileSync(join(confoundOut, "review.md"), "utf8");
    expect(md).toContain("Label: `no_suspect`");
    expect(md).toContain("No setup is flagged");
    expect(md).not.toContain("not part of this command");
  });

  test("every outcome carries a difficulty and a tercile", () => {
    const outcomes = JSON.parse(readFileSync(join(confoundOut, "outcomes.json"), "utf8")) as Outcome[];
    expect(outcomes).toHaveLength(27);
    for (const o of outcomes) {
      expect(typeof o.difficulty).toBe("number");
      expect([1, 2, 3]).toContain(o.tercile as number);
    }
  });

  test("the timing line reports difficulty as run, not as not run", () => {
    const timing = confound.out.split("\n").find((l) => l.startsWith("time: "));
    expect(timing).toBeDefined();
    expect(timing).toMatch(/difficulty \d+\.\d{2}s/);
    expect(timing).not.toContain("not run");
  });

  test("a review with too few mature sessions is insufficient data, and says why", () => {
    expect(basic.code).toBe(0);
    const review = JSON.parse(readFileSync(join(basicOut, "review.json"), "utf8")) as Review;
    expect(review).toMatchObject({ label: "insufficient_data", suspect: null, odds_ratio: null, ci95: null, p_value: null });
    expect(validateReview(review)).toEqual([]);
    const md = readFileSync(join(basicOut, "review.md"), "utf8");
    expect(md).toContain("no setup has ≥ 8 mature sessions");
    expect(md).not.toContain("not part of this command");
  });
});
