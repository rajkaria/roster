import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sumcheck } from "../scripts/sumcheck.ts";
import {
  buildSetupRows,
  buildTags,
  OPTIONAL_REVIEW_KEYS,
  parseRemote,
  repoSlug,
  REVIEW_KEYS,
  SETUP_ROW_KEYS,
  validateReview,
} from "../src/review/export.ts";
import type { Outcome, Review, Session, SetupRow } from "../src/types.ts";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli.ts");
const MAKE_FIXTURE = join(import.meta.dir, "fixtures", "make-fixture.ts");

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function run(cmd: string[], cwd: string) {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...GIT_ENV, NEATLOGS_API_KEY: "" } });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

let work: string;
let outDir: string;
let review: Review;
let raw: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "roster-contract-"));
  const repo = join(work, "fixture");
  const built = run([process.execPath, MAKE_FIXTURE, repo, "--scenario", "basic"], ROOT);
  if (built.code !== 0) throw new Error(`make-fixture failed: ${built.err}`);
  outDir = join(work, "reports", "fixture");
  const r = run([process.execPath, CLI, "review", repo, "--observational", "--out", outDir, "--cache", join(work, "cache")], ROOT);
  if (r.code !== 0) throw new Error(`roster review failed: ${r.err}`);
  raw = readFileSync(join(outDir, "review.json"), "utf8");
  review = JSON.parse(raw) as Review;
}, 120_000);

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

const isRate = (v: unknown) => v === null || (typeof v === "number" && v >= 0 && v <= 1);
const nullableNum = (v: unknown) => v === null || typeof v === "number";

describe("review.json from the T01 fixture", () => {
  test("validates and carries the contract fields", () => {
    expect(validateReview(review)).toEqual([]);
    for (const k of REVIEW_KEYS) expect(k in review).toBe(true);
    expect(Object.keys(review).every((k) => (REVIEW_KEYS as readonly string[]).includes(k) || (OPTIONAL_REVIEW_KEYS as readonly string[]).includes(k))).toBe(true);
    expect(review.repo).toBe("fixture");
    expect(review.has_entire_data).toBe(true);
    expect(new Date(review.generated_at).toISOString()).toBe(review.generated_at);
    expect(review.evidence_level).toBe("A");
    expect(review.label).toBe("insufficient_data");
  });

  test("every SetupRow field has its type", () => {
    expect(review.setups.length).toBeGreaterThan(0);
    for (const row of review.setups) {
      expect(Object.keys(row).sort()).toEqual([...SETUP_ROW_KEYS].sort());
      for (const k of ["setup_id", "label", "harness", "model"] as const) expect(typeof row[k]).toBe("string");
      expect(row.rules_hash === null || typeof row.rules_hash === "string").toBe(true);
      expect(Number.isInteger(row.sessions)).toBe(true);
      expect(Number.isInteger(row.mature_sessions)).toBe(true);
      expect(row.mature_sessions).toBeLessThanOrEqual(row.sessions);
      expect(typeof row.spend_usd).toBe("number");
      expect(typeof row.surviving_changes).toBe("number");
      expect(nullableNum(row.cost_per_surviving_change)).toBe(true);
      for (const k of ["unattended", "survival", "reverted", "rework_human"] as const) expect(isRate(row[k])).toBe(true);
      if (row.mature_sessions === 0) expect([row.unattended, row.survival, row.reverted, row.rework_human]).toEqual([null, null, null, null]);
      expect(row.evidence_level).toBe("A");
    }
  });

  test("setup rows add up to the sessions written next to them", () => {
    const sessions = JSON.parse(readFileSync(join(outDir, "sessions.json"), "utf8")) as Session[];
    const withSetup = sessions.filter((s) => s.setup_id !== null).length;
    expect(review.setups.reduce((a, r) => a + r.sessions, 0)).toBe(withSetup);
  });

  test("review.md renders the same setups", () => {
    const md = readFileSync(join(outDir, "review.md"), "utf8");
    for (const row of review.setups) expect(md).toContain(`\`${row.setup_id}\``);
  });

  test("scripts/sumcheck.ts passes on the output", () => {
    const res = sumcheck(join(work, "reports"));
    expect(res.files).toBeGreaterThan(0);
    expect(res.mismatches).toEqual([]);
  });
});

describe("repo slug", () => {
  test("https and ssh remotes give owner/name", () => {
    expect(parseRemote("https://github.com/acme/widgets.git")).toBe("acme/widgets");
    expect(parseRemote("https://github.com/acme/widgets")).toBe("acme/widgets");
    expect(parseRemote("git@github.com:acme/widgets.git")).toBe("acme/widgets");
    expect(parseRemote("ssh://git@github.com/acme/widgets.git")).toBe("acme/widgets");
    expect(repoSlug("https://github.com/acme/widgets.git")).toBe("acme/widgets");
    expect(parseRemote("/some/local/path")).toBeNull();
  });

  test("a local repo uses its origin remote, https or ssh", () => {
    for (const [name, url] of [["h", "https://github.com/acme/widgets.git"], ["s", "git@github.com:acme/widgets.git"]] as const) {
      const dir = join(work, name);
      mkdirSync(dir);
      run(["git", "init", "-q"], dir);
      run(["git", "remote", "add", "origin", url], dir);
      expect(repoSlug(dir)).toBe("acme/widgets");
    }
  });

  test("no remote falls back to the directory basename", () => {
    const dir = join(work, "no-remote");
    mkdirSync(dir);
    run(["git", "init", "-q"], dir);
    expect(repoSlug(dir)).toBe("no-remote");
  });
});

describe("builders", () => {
  const session = (id: string, setup: string | null, cost: number | null, commit: string | null, prompt = "do it"): Session => ({
    id,
    repo: "r",
    checkpoint_id: "c",
    harness: "claude-code",
    model: "m",
    rules_hash: "h",
    setup_id: setup,
    tokens_in: 0,
    tokens_out: 0,
    cache_read: 0,
    cache_write: 0,
    cost_usd: cost,
    n_user_prompts: 1,
    first_prompt: prompt,
    commit_sha: commit,
    started_at: "2026-01-01T00:00:00Z",
    ended_at: "2026-01-01T00:01:00Z",
    files: [],
    entire_url: null,
    source: "branch",
  });
  const mature = (id: string, survival: number, rework: number): Outcome => ({
    session_id: id,
    status: "mature",
    survival,
    reverted: false,
    rework_human: rework,
    rework_agent: 0,
    unattended: true,
    tests_at_commit: null,
    difficulty: null,
    tercile: null,
  });
  const young = (id: string): Outcome => ({ ...mature(id, 0, 0), status: "too_young", survival: null, reverted: null, rework_human: null, rework_agent: null, unattended: null });

  test("a setup with no mature session has null rates and mature_sessions 0", () => {
    const rows: SetupRow[] = buildSetupRows([session("a", "s1", 1, "x"), session("b", "s2", 2, null)], [mature("a", 0.5, 0.2), young("b")]);
    expect(rows.map((r) => r.setup_id)).toEqual(["s1", "s2"]);
    expect(rows[0]).toMatchObject({ mature_sessions: 1, survival: 0.5, rework_human: 0.2, surviving_changes: 0.5, cost_per_surviving_change: 2, spend_usd: 1 });
    expect(rows[1]).toMatchObject({ mature_sessions: 0, survival: null, reverted: null, unattended: null, rework_human: null, cost_per_surviving_change: null });
  });

  test("tags: sessions and inferred ids per tag, and none without tags", () => {
    expect(buildTags([session("a", "s1", 1, null)])).toBeUndefined();
    const tags = buildTags([
      session("a", "s1", 1, null, "[roster setup=A task=T1] go"),
      session("b", "s1", 1, null, "[roster setup=A task=T2] go"),
      session("c", "s2", 1, null, "[roster setup=B task=T3] go"),
    ]);
    expect(tags).toEqual({
      by_tag: { A: { sessions: 2, setup_ids: ["s1"] }, B: { sessions: 1, setup_ids: ["s2"] } },
      tag_accuracy: 1,
    });
  });

  test("validateReview rejects a malformed row", () => {
    const bad = { ...review, setups: [{ ...review.setups[0]!, survival: 2 }] };
    expect(validateReview(bad)).toContain("setups[0].survival must be null or a number in [0, 1]");
  });
});
