// T53: the batched scorer gives the same outcomes as the per-session one, with fewer, bounded git calls.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatTimings, scoreAll, scoreSession } from "../src/cli/review.ts";
import { parseCheckpoints, type ParsedSession } from "../src/ingest/parse.ts";
import { gitPool, GIT_PARALLEL, spawnGit, type GitRunner } from "../src/score/rework.ts";
import { survivalMany, type BlameCache } from "../src/score/survival.ts";
import type { Outcome } from "../src/types.ts";
import { git, makeFixture, SCENARIOS } from "./fixtures/make-fixture.ts";

setDefaultTimeout(120_000);

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli.ts");
const root = mkdtempSync(join(tmpdir(), "roster-review-perf-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A runner that records every git command and the most it ever had in flight. */
function counting(): { run: GitRunner; calls: string[][]; peak: () => number } {
  const calls: string[][] = [];
  let active = 0;
  let peak = 0;
  const inner: GitRunner = async (repo, args, stdin) => {
    calls.push(args);
    peak = Math.max(peak, ++active);
    try {
      return await spawnGit(repo, args, stdin);
    } finally {
      active--;
    }
  };
  return { run: gitPool(inner), calls, peak: () => peak };
}

interface Fixture {
  repo: string;
  sessions: ParsedSession[];
  ctx: { repo: string; head: string; headTime: number };
}

function fixture(scenario: (typeof SCENARIOS)[number]): Fixture {
  const repo = join(root, scenario);
  makeFixture(repo, scenario);
  const sessions = parseCheckpoints(repo, "auto", { warn: () => {} });
  const head = git(repo, ["rev-parse", "HEAD"]).trim();
  const headTime = Number(git(repo, ["show", "-s", "--format=%ct", head]).trim());
  return { repo, sessions, ctx: { repo, head, headTime } };
}

/** The per-session path the review used before T53, as the reference. */
function before(f: Fixture): (Outcome | string)[] {
  return f.sessions.map((s) => {
    try {
      return scoreSession(s, f.ctx);
    } catch (err) {
      return `error: ${(err as Error).message}`;
    }
  });
}

const blameKey = (args: string[]) => {
  if (!args.includes("blame")) return null;
  return `${args.at(-1)}@${args[args.indexOf("--") - 1]}`;
};

describe("batched scoring matches the per-session scorer", () => {
  for (const scenario of SCENARIOS) {
    test(`${scenario} fixture: identical outcomes`, async () => {
      const f = fixture(scenario);
      const ref = before(f);
      expect(ref.some((o) => typeof o !== "string" && o.status === "mature")).toBe(true);
      const after = (await scoreAll(f.sessions, f.ctx, counting().run)).map((o) => (o instanceof Error ? `error: ${o.message}` : o));
      expect(after).toEqual(ref);
    });
  }
});

describe("the T01 fixture (scenario basic): git commands", () => {
  let f: Fixture;
  let c: ReturnType<typeof counting>;
  let outcomes: (Outcome | Error)[];

  beforeAll(async () => {
    f = fixture("basic");
    c = counting();
    outcomes = await scoreAll(f.sessions, f.ctx, c.run);
  });

  test("blame runs once per (file, HEAD)", () => {
    const keys = c.calls.map(blameKey).filter((k): k is string => k !== null);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k.endsWith(`@${f.ctx.head}`)).toBe(true);
  });

  test("blame is shared across sessions that touch the same file", async () => {
    const mature = outcomes.filter((o): o is Outcome => !(o instanceof Error) && o.status === "mature").length;
    const files = new Set(c.calls.map(blameKey).filter((k) => k !== null)).size;
    // Two calls of survivalMany over the same cache: the second blames nothing.
    const cache: BlameCache = new Map();
    const c2 = counting();
    const shas = f.sessions.map((s) => s.commit_sha).filter((x): x is string => x !== null);
    const full = shas.map((s) => git(f.repo, ["rev-parse", s]).trim());
    await survivalMany(f.repo, full.map((s) => [s]), f.ctx.head, c2.run, cache);
    const first = c2.calls.filter((a) => a.includes("blame")).length;
    await survivalMany(f.repo, full.map((s) => [s]), f.ctx.head, c2.run, cache);
    expect(c2.calls.filter((a) => a.includes("blame")).length).toBe(first);
    expect(mature).toBeGreaterThan(0);
    expect(first).toBe(files);
  });

  test("rework and reverts read history in one first-parent log and one patch log, no per-session diffs", () => {
    const logs = c.calls.filter((a) => a[0] === "log");
    expect(logs.filter((a) => a.includes("--first-parent") && a.at(-1) === "HEAD").length).toBe(1);
    expect(logs.filter((a) => a.includes("-p")).length).toBe(1);
    expect(c.calls.filter((a) => a[0] === "diff").length).toBe(0);
  });

  test(`at most ${GIT_PARALLEL} git processes run at once, and they do overlap`, () => {
    expect(c.peak()).toBeLessThanOrEqual(GIT_PARALLEL);
    expect(c.peak()).toBeGreaterThan(1);
  });
});

describe("roster review on the T01 fixture", () => {
  let out: string;
  let dir: string;
  let f: Fixture;

  beforeAll(() => {
    f = fixture("basic");
    dir = join(root, "reports");
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", NEATLOGS_API_KEY: "" };
    const r = Bun.spawnSync([process.execPath, CLI, "review", f.repo, "--observational", "--out", dir, "--cache", join(root, "cache")], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    if (r.exitCode !== 0) throw new Error(`roster review failed: ${r.stderr.toString()}`);
    out = r.stdout.toString();
  });

  test("outcomes.json equals the per-session scorer's outcomes", () => {
    const written = JSON.parse(readFileSync(join(dir, "outcomes.json"), "utf8")) as Outcome[];
    expect(written).toEqual(before(f) as Outcome[]);
  });

  test("ends with the wall time of every stage", () => {
    const line = out.trim().split("\n").at(-1)!;
    expect(line).toMatch(/^time: fetch \d+\.\d\ds · parse \d+\.\d\ds · identify \d+\.\d\ds · score \d+\.\d\ds · difficulty not run · export \d+\.\d\ds · total \d+\.\d\ds$/);
  });
});

test("formatTimings marks a stage that did not run", () => {
  const t = new Map([["fetch", 1500], ["parse", 20]]);
  expect(formatTimings(t, 1600)).toBe("time: fetch 1.50s · parse 0.02s · identify not run · score not run · difficulty not run · export not run · total 1.60s");
});
