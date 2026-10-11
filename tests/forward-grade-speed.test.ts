import { describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignLabels, type Harness, pairSeed, rng, runForward } from "../src/forward/index.ts";
import type { StepKind } from "../src/grade/index.ts";
import type { LlmClient } from "../src/llm/types.ts";
import { runGit } from "../src/sandbox/index.ts";

function makeWorld() {
  const root = mkdtempSync(join(tmpdir(), "roster-gradespeed-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "suite.sh"), "true\n");
  runGit(repo, ["init", "-q", "-b", "main"]);
  runGit(repo, ["add", "-A"]);
  runGit(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"]);
  // Untracked, so it is not in the sandbox archive: the grading copy must link it from the repo.
  mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "x\n");
  mkdirSync(join(repo, "web", "node_modules"), { recursive: true });
  const acceptance = join(root, "acceptance", "T1");
  mkdirSync(acceptance, { recursive: true });
  writeFileSync(join(acceptance, "check-T1.sh"), "grep -q ok answer-T1.txt\n");
  const backlog = "<!-- T1 -->\n[roster setup=X task=T1]\nWrite ok.\nOWNS: answer-T1.txt\n<!-- /T1 -->\n";
  return { root, repo, backlog, acceptanceDir: join(root, "acceptance") };
}

/** Each side writes its answer; acceptance greps for "ok". */
const harnessWith = (answer: (side: "old" | "new") => string): Harness => async (req) => {
  writeFileSync(join(req.worktree, "answer-T1.txt"), answer(req.side));
  runGit(req.worktree, ["add", "-A"]);
  runGit(req.worktree, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", `T1: ${req.side}`]);
  return { costUsd: 0.1 };
};

const llm: LlmClient = {
  async chat() {
    return { message: { role: "assistant", content: "verdict: X" }, toolCalls: [], usage: { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 }, costUsd: 0, model: "fake" };
  },
};

describe("forward grading speed", () => {
  test("links node_modules, runs the suite once when one side passes acceptance, records timings", async () => {
    const w = makeWorld();
    const calls: { kind: StepKind; modules: boolean; webModules: boolean }[] = [];
    const runner = (cwd: string, _cmd: string, _t: number, kind: StepKind) => {
      calls.push({
        kind,
        modules: lstatSync(join(cwd, "node_modules")).isSymbolicLink(),
        webModules: lstatSync(join(cwd, "web", "node_modules")).isSymbolicLink(),
      });
      // Stub acceptance: the answer file says ok.
      return kind !== "hidden" || readFileSync(join(cwd, "answer-T1.txt"), "utf8").includes("ok");
    };
    const summary = await runForward({
      repo: w.repo, backlog: w.backlog, pair: { old: "A", new: "B" }, parallel: 1, harness: harnessWith((side) => (side === "old" ? "bad\n" : "ok new\n")), llm,
      db: join(w.root, "s.db"), wtRoot: join(w.root, "wt"), acceptanceDir: w.acceptanceDir,
      testCmd: "sh suite.sh", seed: 1, gradeRunner: runner,
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.modules && c.webModules)).toBe(true);
    expect(calls.filter((c) => c.kind === "suite")).toHaveLength(1);
    expect(calls.filter((c) => c.kind === "hidden")).toHaveLength(2);

    // Only new passes acceptance, so only new's suite runs; old's is "not run".
    const p = summary.completed[0]!;
    expect(p).toMatchObject({ pass_old: false, pass_new: true, merged: "new", suite_pass_new: true, suite_pass_old: null });
    for (const k of ["agent_old_ms", "agent_new_ms", "grade_ms"] as const) {
      expect(typeof p[k]).toBe("number");
      expect(p[k]!).toBeGreaterThanOrEqual(0);
    }
  }, 60_000);

  test("both sides pass acceptance: each side's suite runs once and sets pass_*; the judge's pick merges", async () => {
    const w = makeWorld();
    const seed = 7;
    const pick = assignLabels(rng(pairSeed(seed, "T1"))).X; // the fake judge says X
    const loser = pick === "old" ? "new" : "old";
    const suites: string[] = [];
    const runner = (cwd: string, _cmd: string, _t: number, kind: StepKind) => {
      if (kind !== "suite") return true;
      const side = readFileSync(join(cwd, "answer-T1.txt"), "utf8").includes("old") ? "old" : "new";
      suites.push(side);
      return side !== loser;
    };
    const summary = await runForward({
      repo: w.repo, backlog: w.backlog, pair: { old: "A", new: "B" }, parallel: 1, harness: harnessWith((side) => `ok ${side}\n`), llm,
      db: join(w.root, "s.db"), wtRoot: join(w.root, "wt"), acceptanceDir: w.acceptanceDir,
      testCmd: "sh suite.sh", seed, gradeRunner: runner, buildMerge: true,
    });
    expect(suites.sort()).toEqual(["new", "old"]);
    // The suite results decide H1 (only the pick passes), so the merge is pass_beats_fail; the judge's preference is the secondary.
    const p = summary.completed[0]!;
    expect(p).toMatchObject({ merged: pick, merged_reason: "pass_beats_fail", secondary: pick, [`pass_${pick}`]: true, [`pass_${loser}`]: false, [`suite_pass_${pick}`]: true, [`suite_pass_${loser}`]: false });
  }, 60_000);
});
