// T68: the pull request for a promotion, and the promotion slug for a local path. Every git and gh call goes through
// an injected runner; nothing here runs a real `gh pr create`.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBackend } from "../src/agent/backend.ts";
import { openPromotion, OPT_INS_FILE, promotionPr, readOptIns, ROSTER_ROOT } from "../src/agent/promote-pr.ts";
import type { Decision, ToolBackend } from "../src/agent/tools.ts";
import { parseRunArgs } from "../src/cli/run.ts";
import type { RunResult, Runner } from "../src/act/open-pr.ts";
import { isAllowed, loadOptIns } from "../src/review/opt-in.ts";
import type { Replay } from "../src/types.ts";

const root = mkdtempSync(join(tmpdir(), "roster-promote-pr-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ORIGIN = "https://github.com/rajkaria/roster.git";
const ALLOWED = loadOptIns([{ repo: "rajkaria/roster", public: true, prAllowed: true }]);

function replay(setup: string, task: string, verdict: Replay["verdict"], over: Partial<Replay> = {}): Replay {
  return {
    id: `${setup}-${task}-1`,
    plan_id: "run-p1",
    task_session_id: task,
    setup_id: setup,
    attempt: 1,
    isolation_proof: "test",
    turns: 3,
    duration_ms: 1000,
    cost_usd: 0.5,
    hidden_pass: verdict === "pass",
    suite_pass: true,
    scope_ok: true,
    judge_equiv: null,
    failure_codes: [],
    verdict,
    transcript_ref: null,
    trace_url: null,
    ...over,
  };
}

const ROWS: Replay[] = [
  replay("A", "t1", "hidden_tests_failed"),
  replay("E", "t1", "pass", { cost_usd: 0.25, trace_url: "https://neatlogs.example/t1" }),
  replay("A", "t2", "pass"),
  replay("E", "t2", "pass", { cost_usd: null }),
  replay("E", "t3", "pass"), // the incumbent never ran t3, so it is not in the body
];

function decision(candidate: string, verdict: Decision["verdict"], reasons: string[] = []): Decision {
  return { id: `run-p1:${candidate}`, plan_id: "run-p1", candidate, verdict, reasons, trace_url: null, failed_tasks: [] };
}

/** The acceptance-test fake: answers git with `origin` and gh with `gh`, and records every argv. */
function stubRun(origin: string, gh: RunResult = { code: 0, stdout: "", stderr: "" }) {
  const calls: string[][] = [];
  const run: Runner = async (cmd) => {
    calls.push(cmd);
    if (cmd[0] === "git") return { code: 0, stdout: origin, stderr: "" };
    if (cmd[0] === "gh") return gh;
    throw new Error(`unexpected command: ${cmd.join(" ")}`);
  };
  return { run, ghCalls: () => calls.filter((c) => c[0] === "gh") };
}

const bodyOf = (command: string[]) => command[command.indexOf("--body-file") + 1]!;

describe("promotionPr", () => {
  test("dry run on rajkaria/roster builds the title and body and never runs gh", async () => {
    const { run, ghCalls } = stubRun(ORIGIN);
    const pr = await promotionPr({
      repoPath: "/tmp/roster",
      decision: decision("E", "promote", ["tie on hidden_pass 0; candidate cheaper"]),
      incumbent: "A",
      replays: ROWS,
      rejected: [decision("B", "reject", ["regressed t2"])],
      optIns: ALLOWED,
      dryRun: true,
      run,
    });

    expect(pr.opened).toBe(false);
    expect(pr.reason).toBe("dry run");
    expect(pr.command.slice(0, 2)).toEqual(["gh", "pr"]);
    expect(pr.command[pr.command.indexOf("--title") + 1]).toBe("Roster: promote E over A");
    const body = bodyOf(pr.command);
    expect(body).toContain("Roster promotes setup `E` over incumbent `A` in `rajkaria/roster`.");
    expect(body).toContain("Evidence level: B");
    expect(body).toContain("| t1 | ✗ | ✓ | 0.75 |");
    expect(body).toContain("| t2 | ✓ | ✓ | 0.50 |");
    expect(body).not.toContain("t3");
    expect(body).toContain("- `B`\n  - regressed t2");
    expect(body).toContain("- t1: [trace](https://neatlogs.example/t1)");
    expect(ghCalls()).toEqual([]);
  });

  test("with --open and a gh that prints a URL, the PR is opened and the URL comes back", async () => {
    const { run, ghCalls } = stubRun(ORIGIN, { code: 0, stdout: "https://github.com/rajkaria/roster/pull/99\n", stderr: "" });
    const pr = await promotionPr({ repoPath: "/tmp/roster", decision: decision("E", "promote"), incumbent: "A", replays: ROWS, optIns: ALLOWED, dryRun: false, run });

    expect(pr.opened).toBe(true);
    expect(pr.url).toBe("https://github.com/rajkaria/roster/pull/99");
    expect(ghCalls()).toHaveLength(1);
  });

  test("a repo not in the registry is refused with the reason, and gh never runs", async () => {
    const { run, ghCalls } = stubRun(ORIGIN);
    const pr = await promotionPr({ repoPath: "/tmp/roster", decision: decision("E", "promote"), incumbent: "A", replays: ROWS, optIns: [], dryRun: false, run });

    expect(pr).toMatchObject({ opened: false, reason: "not opted in", command: [] });
    expect(ghCalls()).toEqual([]);
  });

  test("a registry entry without prAllowed does not allow a PR", async () => {
    const { run, ghCalls } = stubRun(ORIGIN);
    const readOnly = loadOptIns([{ repo: "rajkaria/roster", public: true, prAllowed: false }]);
    const pr = await promotionPr({ repoPath: "/tmp/roster", decision: decision("E", "promote"), incumbent: "A", replays: ROWS, optIns: readOnly, dryRun: false, run });

    expect(pr.reason).toBe("not opted in");
    expect(ghCalls()).toEqual([]);
  });
});

describe("opt-in registry", () => {
  test("the repo's opt-ins.json allows rajkaria/roster to open a PR", () => {
    expect(ROSTER_ROOT).toBe(join(import.meta.dir, ".."));
    const optIns = readOptIns(join(ROSTER_ROOT, OPT_INS_FILE));
    expect(isAllowed(optIns, "rajkaria/roster", "open-pr")).toBe(true);
  });

  test("a missing or unreadable registry allows nothing", async () => {
    expect(readOptIns(join(root, "no-such-dir", "opt-ins.json"))).toEqual([]);
    const bad = join(root, "bad-opt-ins.json");
    await Bun.write(bad, "{not json");
    expect(readOptIns(bad)).toEqual([]);
  });
});

describe("openPromotion", () => {
  test("with --open, the PR URL is recorded in promotion.json under pr", async () => {
    const reportsDir = join(root, "reports-open");
    const backend = defaultBackend({ reportsDir, cacheDir: join(root, "cache") });
    await backend.promote({ repo: ORIGIN, candidate: "E", decision: decision("E", "promote", ["cheaper"]), from: "A" });
    const stub: Partial<ToolBackend> = { getReplayResults: async () => ROWS };
    const { run } = stubRun(ORIGIN, { code: 0, stdout: "https://github.com/rajkaria/roster/pull/99\n", stderr: "" });

    const pr = await openPromotion({
      reviewDir: join(reportsDir, "rajkaria__roster"),
      repoPath: "/tmp/roster",
      backend: stub as ToolBackend,
      decisions: [decision("E", "promote")],
      dryRun: false,
      setupsRoot: ROSTER_ROOT,
      optIns: ALLOWED,
      run,
    });

    expect(pr?.url).toBe("https://github.com/rajkaria/roster/pull/99");
    const doc = JSON.parse(readFileSync(join(reportsDir, "rajkaria__roster", "promotion.json"), "utf8"));
    expect(doc.promoted).toBe("E");
    expect(doc.pr).toMatchObject({ opened: true, url: "https://github.com/rajkaria/roster/pull/99" });
  });

  test("a refused repo is recorded with its reason, and the promotion still stands", async () => {
    const reportsDir = join(root, "reports-refused");
    const backend = defaultBackend({ reportsDir, cacheDir: join(root, "cache") });
    await backend.promote({ repo: ORIGIN, candidate: "E", decision: decision("E", "promote"), from: "A" });
    const stub: Partial<ToolBackend> = { getReplayResults: async () => ROWS };
    const { run, ghCalls } = stubRun(ORIGIN);

    await openPromotion({
      reviewDir: join(reportsDir, "rajkaria__roster"),
      repoPath: "/tmp/roster",
      backend: stub as ToolBackend,
      decisions: [decision("E", "promote")],
      dryRun: false,
      setupsRoot: ROSTER_ROOT,
      optIns: [],
      run,
    });

    const doc = JSON.parse(readFileSync(join(reportsDir, "rajkaria__roster", "promotion.json"), "utf8"));
    expect(doc.promoted).toBe("E");
    expect(doc.pr).toMatchObject({ opened: false, reason: "not opted in" });
    expect(ghCalls()).toEqual([]);
  });

  test("nothing promoted means no PR step", async () => {
    const reviewDir = join(root, "reports-none", "rajkaria__roster");
    expect(await openPromotion({ reviewDir, repoPath: "/tmp/roster", backend: {} as ToolBackend, decisions: [], dryRun: true })).toBeNull();
  });
});

describe("promote() slug", () => {
  test('promote(".") in a checkout whose origin is github.com/rajkaria/roster writes reports/rajkaria__roster/promotion.json', async () => {
    const checkout = join(root, "checkout");
    mkdirSync(checkout);
    Bun.spawnSync(["git", "init", "-q"], { cwd: checkout });
    Bun.spawnSync(["git", "remote", "add", "origin", ORIGIN], { cwd: checkout });
    const reportsDir = join(root, "reports-dot");
    const backend = defaultBackend({ reportsDir, cacheDir: join(root, "cache") });

    const before = process.cwd();
    process.chdir(checkout);
    try {
      await backend.promote({ repo: ".", candidate: "E", decision: decision("E", "promote"), from: "A" });
    } finally {
      process.chdir(before);
    }

    expect(existsSync(join(reportsDir, "rajkaria__roster", "promotion.json"))).toBe(true);
    expect(existsSync(join(reportsDir, "promotion.json"))).toBe(false);
  });

  test("a local path with no origin keeps its basename as the slug", async () => {
    const plain = join(root, "plain-dir");
    mkdirSync(plain);
    const reportsDir = join(root, "reports-plain");
    await defaultBackend({ reportsDir, cacheDir: join(root, "cache") }).promote({
      repo: plain,
      candidate: "E",
      decision: decision("E", "promote"),
      from: "A",
    });
    expect(existsSync(join(reportsDir, "plain-dir", "promotion.json"))).toBe(true);
  });
});

describe("roster run --pr / --open", () => {
  test("--pr is a dry run by default; --open needs --pr", () => {
    expect(parseRunArgs(["repo", "--budget", "1", "--pr"])).toMatchObject({ pr: true, open: false });
    expect(parseRunArgs(["repo", "--budget", "1", "--pr", "--open"])).toMatchObject({ pr: true, open: true });
    expect(parseRunArgs(["repo", "--budget", "1"])).toMatchObject({ pr: false, open: false });
    expect(() => parseRunArgs(["repo", "--budget", "1", "--open"])).toThrow("--open needs --pr");
  });
});
