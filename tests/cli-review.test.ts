import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS, main } from "../src/cli.ts";
import { parseReviewArgs, UsageError } from "../src/cli/review.ts";
import { type Outcome, type Review, type Session } from "../src/types.ts";
import {
  buildSetupRows,
  OPTIONAL_REVIEW_KEYS,
  REVIEW_KEYS,
  renderReviewMarkdown,
  repoLabel,
  reviewSlug,
  summarizeSetups,
  validateReview,
} from "../src/review/export.ts";
import { sumcheck } from "../scripts/sumcheck.ts";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli.ts");
const MAKE_FIXTURE = join(import.meta.dir, "fixtures", "make-fixture.ts");

// The fixture ground truth, as make-fixture.ts writes it.
interface Truth {
  checkpoints: { id: string; sessions: { session_id: string; setup: string }[] }[];
}

/** Runs the real CLI in a subprocess. Neatlogs is forced off so no test ever sends a trace. */
function runCli(args: string[]) {
  const p = Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NEATLOGS_API_KEY: "" },
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function git(cwd: string, args: string[]) {
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
}

let work: string;
let fixtureRepo: string;
let emptyRepo: string;
let truth: Truth;
let outDir: string;
let cli: ReturnType<typeof runCli>;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "roster-cli-review-"));

  // Built by the fixture script from the redacted samples; never hand-written.
  fixtureRepo = join(work, "fixture");
  const built = Bun.spawnSync([process.execPath, MAKE_FIXTURE, fixtureRepo, "--scenario", "basic"], { stdout: "pipe", stderr: "pipe" });
  if (built.exitCode !== 0) throw new Error(`make-fixture failed: ${built.stderr.toString()}`);
  truth = JSON.parse(readFileSync(join(fixtureRepo, ".git", "roster-fixture.json"), "utf8")) as Truth;

  // A repo with commits but no Entire checkpoints.
  emptyRepo = join(work, "empty");
  mkdirSync(emptyRepo);
  git(emptyRepo, ["init", "-q", "-b", "main"]);
  git(emptyRepo, ["commit", "-q", "--allow-empty", "-m", "init"]);
}, 120_000);

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

describe("arguments", () => {
  test("repo and --observational are enough; defaults fill the rest", () => {
    expect(parseReviewArgs(["some/repo", "--observational"])).toEqual({ repo: "some/repo", out: undefined, cache: ".roster/cache" });
  });

  test("--out takes a value inline or as the next argument", () => {
    expect(parseReviewArgs(["r", "--observational", "--out", "d1"]).out).toBe("d1");
    expect(parseReviewArgs(["r", "--observational", "--out=d2"]).out).toBe("d2");
  });

  test("other --out-like flags are rejected, not read as --out", () => {
    expect(() => parseReviewArgs(["r", "--observational", "--outfoo", "d"])).toThrow(/unknown flag --outfoo/);
  });

  test("the replay path is refused until it is built", () => {
    expect(() => parseReviewArgs(["r"])).toThrow(UsageError);
    expect(() => parseReviewArgs(["r"])).toThrow(/only --observational/);
  });

  test("a missing repo, a missing value and a second positional are usage errors", () => {
    expect(() => parseReviewArgs(["--observational"])).toThrow(/missing <repo>/);
    expect(() => parseReviewArgs(["r", "--observational", "--out"])).toThrow(/--out needs a value/);
    expect(() => parseReviewArgs(["r", "x", "--observational"])).toThrow(/unexpected argument x/);
  });
});

describe("registry", () => {
  test("review is registered", () => {
    expect(COMMANDS.map((c) => c.name)).toContain("review");
  });

  test("help exits 0 and an unknown command exits 2", async () => {
    // main prints usage; keep the test output clean.
    const { log, error } = console;
    console.log = () => {};
    console.error = () => {};
    try {
      expect(await main(["help"])).toBe(0);
      expect(await main(["no-such-command"])).toBe(2);
      expect(await main([])).toBe(2);
    } finally {
      console.log = log;
      console.error = error;
    }
  });
});

describe("export", () => {
  test("slugs and labels follow the web app's owner__repo lookup", () => {
    expect(reviewSlug("https://github.com/acme/widgets.git")).toBe("acme__widgets");
    expect(repoLabel("git@github.com:acme/widgets.git")).toBe("acme/widgets");
    expect(reviewSlug("/work/projects/roster/")).toBe("roster");
  });

  test("a complete insufficient-data review validates", () => {
    const review: Review = {
      id: "r-1",
      repo: "acme/widgets",
      created_at: "2026-10-10T00:00:00.000Z",
      generated_at: "2026-10-10T00:00:00.000Z",
      has_entire_data: true,
      setups: [],
      label: "insufficient_data",
      suspect: null,
      odds_ratio: null,
      ci95: null,
      p_value: null,
      evidence_level: "A",
    };
    expect(validateReview(review)).toEqual([]);
    // Keeps the runtime key list in step with the Review type: a new field in src/types.ts fails the typecheck here.
    const everyKey: Record<keyof Review, true> = {
      id: true,
      repo: true,
      created_at: true,
      generated_at: true,
      has_entire_data: true,
      setups: true,
      tags: true,
      label: true,
      suspect: true,
      odds_ratio: true,
      ci95: true,
      p_value: true,
      evidence_level: true,
    };
    const runtimeKeys: string[] = [...REVIEW_KEYS];
    // `tags` is optional: written only when sessions carry prompt tags.
    const allKeys: string[] = [...REVIEW_KEYS, ...OPTIONAL_REVIEW_KEYS];
    expect(allKeys.sort()).toEqual(Object.keys(everyKey).sort());
    expect(runtimeKeys.sort()).toEqual(Object.keys(review).sort());
  });

  test("validateReview names each way a review fails the type", () => {
    const good = {
      id: "r",
      repo: "x",
      created_at: "2026-10-10T00:00:00.000Z",
      generated_at: "2026-10-10T00:00:00.000Z",
      has_entire_data: true,
      setups: [],
      label: "insufficient_data",
      suspect: null,
      odds_ratio: null,
      ci95: null,
      p_value: null,
      evidence_level: "A",
    };
    const problems = (patch: Record<string, unknown>, drop: string[] = []) => {
      const v: Record<string, unknown> = { ...good, ...patch };
      for (const k of drop) delete v[k];
      return validateReview(v);
    };
    expect(problems({}, ["p_value"])).toContain("missing p_value");
    expect(problems({ extra: 1 })).toContain("unexpected key extra");
    expect(problems({ evidence_level: "D" })).toContain("evidence_level must be A, B or C");
    expect(problems({ label: "suspect" })).toContain("suspect must name a setup when label is suspect");
    expect(problems({ suspect: "abc" })).toContain("suspect must be null unless label is suspect");
    expect(problems({ ci95: [2, 1] })).toContain("ci95 must be null or [low, high] with low <= high");
    expect(problems({ p_value: 1.5 })).toContain("p_value must be null or a number in [0, 1]");
    expect(problems({ created_at: "soon" })).toContain("created_at is not a date");
    expect(problems({ generated_at: "soon" })).toContain("generated_at is not a date");
    expect(problems({ has_entire_data: "yes" })).toContain("has_entire_data must be a boolean");
    expect(problems({ setups: {} })).toContain("setups must be an array");
    expect(problems({}, ["setups"])).toContain("missing setups");
    expect(problems({ tags: [] })).toContain("tags must be { by_tag, tag_accuracy }");
    expect(validateReview("review")).toEqual(["review must be an object"]);
  });

  test("setup summaries count only mature sessions for rates", () => {
    const s = (id: string, setup: string | null, cost: number | null): Session => ({
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
      cost_usd: cost,
      n_user_prompts: 1,
      first_prompt: "",
      commit_sha: "a",
      started_at: "",
      ended_at: "",
      files: [],
      entire_url: null,
      source: "branch",
    });
    const o = (id: string, status: Outcome["status"], reverted: boolean | null): Outcome => ({
      session_id: id,
      status,
      survival: status === "mature" ? 0.5 : null,
      reverted,
      rework_human: null,
      rework_agent: null,
      unattended: status === "mature" ? true : null,
      tests_at_commit: null,
      difficulty: null,
      tercile: null,
    });
    const [row] = summarizeSetups(
      [s("a", "S1", 1.25), s("b", "S1", null), s("c", "S1", 2), s("d", null, 9)],
      [o("a", "mature", true), o("b", "too_young", null), o("c", "mature", false)],
    );
    expect(row).toMatchObject({ setup_id: "S1", sessions: 3, mature: 2, spend_usd: 3.25, unpriced: 1, reverted: 0.5, unattended: 1 });
    const mdSessions = [s("a", "S1", 1.25)];
    const mdOutcomes = [o("a", "mature", true)];
    const md = renderReviewMarkdown({
      review: { id: "r", repo: "x", created_at: "t", generated_at: "t", has_entire_data: true, setups: buildSetupRows(mdSessions, mdOutcomes), label: "insufficient_data", suspect: null, odds_ratio: null, ci95: null, p_value: null, evidence_level: "A" },
      note: "n",
      sessions: mdSessions,
      outcomes: mdOutcomes,
      notes: ["none"],
    });
    expect(md).toContain("| `S1` |");
    expect(md).toContain("Evidence level: A (observational)");
  });
});

describe("roster review on the fixture", () => {
  beforeAll(() => {
    outDir = join(work, "out");
    cli = runCli(["review", fixtureRepo, "--observational", "--out", outDir, "--cache", join(work, "cache")]);
  }, 120_000);

  test("exits 0 and prints one progress line per stage", () => {
    expect(cli.err).not.toMatch(/roster review:/);
    expect(cli.code).toBe(0);
    for (const line of ["[1/4] fetch:", "[2/4] parse: 4 sessions", "[3/4] identify: 3 setups", "[4/4] score: 4 mature, 0 too young"]) {
      expect(cli.out).toContain(line);
    }
  });

  test("review.json validates against the Review type", () => {
    const review = JSON.parse(readFileSync(join(outDir, "review.json"), "utf8"));
    expect(validateReview(review)).toEqual([]);
    // The fixture's prompts carry setup tags, so the optional `tags` block is written.
    expect(Object.keys(review).sort()).toEqual([...REVIEW_KEYS, ...OPTIONAL_REVIEW_KEYS].sort());
    expect(review.has_entire_data).toBe(true);
    expect(review.setups).toHaveLength(3);
    expect(review).toMatchObject({ repo: "fixture", label: "insufficient_data", suspect: null, evidence_level: "A" });
  });

  test("the written reports pass sumcheck", () => {
    const { files, mismatches } = sumcheck(outDir);
    expect(files).toBe(3); // review.json, sessions.json, outcomes.json
    expect(mismatches).toEqual([]);
  });

  test("every session is written once, with a setup id; the three setups stay distinct", () => {
    const sessions = JSON.parse(readFileSync(join(outDir, "sessions.json"), "utf8")) as Session[];
    const expected = new Set(truth.checkpoints.flatMap((c) => c.sessions.map((s) => s.session_id)));
    expect(new Set(sessions.map((s) => s.id))).toEqual(expected);
    expect(sessions).toHaveLength(expected.size);

    const setupOf = new Map<string, string | null>();
    for (const cp of truth.checkpoints) for (const s of cp.sessions) setupOf.set(s.session_id, s.setup);
    const byTruth = new Map<string, Set<string | null>>();
    for (const s of sessions) {
      const key = setupOf.get(s.id)!;
      (byTruth.get(key) ?? byTruth.set(key, new Set()).get(key)!).add(s.setup_id);
    }
    for (const ids of byTruth.values()) expect(ids.size).toBe(1);
    const distinct = new Set([...byTruth.values()].map((ids) => [...ids][0]));
    expect(distinct.size).toBe(3);
  });

  test("outcomes match the fixture's ground truth", () => {
    const outcomes = JSON.parse(readFileSync(join(outDir, "outcomes.json"), "utf8")) as Outcome[];
    const bySession = new Map(outcomes.map((o) => [o.session_id, o]));
    const session = (checkpoint: string) => truth.checkpoints.find((c) => c.id === checkpoint)!.sessions[0]!.session_id;

    // gamma (setup Z) was reverted by an explicit revert commit, so nothing of it survives.
    expect(bySession.get(session("b8911452cd05"))).toMatchObject({ status: "mature", reverted: true, survival: 0 });
    // beta (setup Y) was left alone.
    expect(bySession.get(session("46e24626a5eb"))).toMatchObject({ status: "mature", reverted: false, survival: 1, rework_human: 0 });
    // alpha (setup X) had one of its lines reworked by a human commit.
    const alpha = bySession.get(session("0739a7286dd4"))!;
    expect(alpha.rework_human).toBeGreaterThan(0);
    expect(alpha.rework_human).toBeLessThan(1);
  });

  test("review.md names the review and its setups", () => {
    const md = readFileSync(join(outDir, "review.md"), "utf8");
    expect(md).toContain("# Review: fixture");
    expect(md).toContain("## Setups");
    expect(md).toContain("Label: `insufficient_data`");
  });
});

// A stand-in for the neatlogs SDK, preloaded into the CLI process. It records each span as one JSON line on stderr.
const NEATLOGS_STUB = `
const stack: string[] = [];
Bun.plugin({
  name: "neatlogs-stub",
  setup(build) {
    build.module("neatlogs", () => ({
      exports: {
        init: async () => true,
        trace: async (opts: { name: string; kind: string }, fn: (span: unknown) => Promise<unknown>) => {
          const rec = { kind: opts.kind, name: opts.name, parent: stack.at(-1) ?? null, attrs: {} as Record<string, unknown> };
          stack.push(opts.name);
          try {
            return await fn({ setAttribute: (k: string, v: unknown) => { rec.attrs[k] = v; } });
          } finally {
            stack.pop();
            console.error("SPAN " + JSON.stringify(rec));
          }
        },
        flush: async () => {},
      },
      loader: "object",
    }));
  },
});
`;

describe("roster review traces", () => {
  let spans: { kind: string; name: string; parent: string | null; attrs: Record<string, unknown> }[] = [];
  let reviewId: string;

  beforeAll(() => {
    const stub = join(work, "neatlogs-stub.ts");
    writeFileSync(stub, NEATLOGS_STUB);
    const traced = join(work, "traced");
    const p = Bun.spawnSync([process.execPath, "--preload", stub, CLI, "review", fixtureRepo, "--observational", "--out", traced, "--cache", join(work, "cache")], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NEATLOGS_API_KEY: "test-key" },
    });
    expect(p.exitCode).toBe(0);
    spans = p.stderr
      .toString()
      .split("\n")
      .filter((l) => l.startsWith("SPAN "))
      .map((l) => JSON.parse(l.slice("SPAN ".length)));
    reviewId = (JSON.parse(readFileSync(join(traced, "review.json"), "utf8")) as Review).id;
  }, 120_000);

  test("one WORKFLOW review root, with a TOOL span per stage under it", () => {
    const roots = spans.filter((s) => s.kind === "WORKFLOW");
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ name: "review", parent: null });
    const tools = spans.filter((s) => s.kind === "TOOL");
    expect(tools.map((s) => s.name)).toEqual(["fetch", "parse", "identify", "score"]);
    for (const t of tools) expect(t.parent).toBe("review");
  });

  test("every span carries the review id as session.id and the repo name", () => {
    for (const s of spans) expect(s.attrs["session.id"]).toBe(reviewId);
    for (const s of spans.filter((x) => x.kind === "TOOL")) expect(s.attrs["roster.repo"]).toBe("fixture");
  });
});

describe("roster review without Entire data", () => {
  test("exits 1 with a clear message and writes no report", () => {
    const out = join(work, "none-out");
    const r = runCli(["review", emptyRepo, "--observational", "--out", out, "--cache", join(work, "cache")]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no Entire data found");
    expect(r.out).toContain("[1/4] fetch: backend=none");
    expect(existsSync(out)).toBe(false);
  }, 120_000);

  test("missing --observational exits 2 with the usage text", () => {
    const r = runCli(["review", emptyRepo]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("only --observational is implemented");
    expect(r.err).toContain("usage: roster review");
  });
});
