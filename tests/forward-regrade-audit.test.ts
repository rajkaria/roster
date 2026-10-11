// Amendment 14: every failed suite is logged with its failing test files (or that it left no JUnit), and a re-merge
// grades through slots like the queue, so its suites don't compete with each other.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForwardStore, type Harness, remergeForward, runForward } from "../src/forward/index.ts";
import type { StepKind } from "../src/grade/index.ts";
import type { LlmClient } from "../src/llm/types.ts";
import { runGit } from "../src/sandbox/index.ts";

const commit = (dir: string, msg: string) => runGit(dir, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", msg]);

function makeWorld(ids: string[]) {
  const root = mkdtempSync(join(tmpdir(), "roster-audit-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "suite.sh"), "true\n");
  runGit(repo, ["init", "-q", "-b", "main"]);
  runGit(repo, ["add", "-A"]);
  commit(repo, "base");
  for (const id of ids) {
    mkdirSync(join(root, "acceptance", id), { recursive: true });
    writeFileSync(join(root, "acceptance", id, `check-${id}.sh`), `grep -q ok answer-${id}.txt\n`);
  }
  const backlog = ids.map((id) => `<!-- ${id} -->\n[roster setup=X task=${id}]\nWrite ok.\nOWNS: answer-${id}.txt\n<!-- /${id} -->\n`).join("\n");
  return { root, repo, backlog, acceptanceDir: join(root, "acceptance"), db: join(root, "s.db"), wtRoot: join(root, "wt") };
}

/** Both sides pass acceptance. */
const harness: Harness = async (req) => {
  writeFileSync(join(req.worktree, `answer-${req.task.id}.txt`), `ok ${req.side}\n`);
  runGit(req.worktree, ["add", "-A"]);
  commit(req.worktree, `${req.task.id}: ${req.side}`);
  return { costUsd: 0.1 };
};

const llm: LlmClient = {
  async chat() {
    return { message: { role: "assistant", content: "verdict: X" }, toolCalls: [], usage: { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 }, costUsd: 0, model: "fake" };
  },
};

const junit = (failing: string[]) =>
  `<?xml version="1.0"?><testsuites>${failing.map((f) => `<testsuite name="${f}" file="${f}"><testcase name="t"><failure/></testcase></testsuite>`).join("")}</testsuites>`;
const outfile = (cmd: string) => /--reporter-outfile=(\S+)/.exec(cmd)?.[1];

describe("failed suites are logged with what failed", () => {
  test("a bun suite logs the files still failing after the retry; a run without JUnit says so", async () => {
    const w = makeWorld(["T1"]);
    const lines: string[] = [];
    await runForward({
      repo: w.repo, backlog: w.backlog, pair: { old: "A", new: "B" }, parallel: 1, harness, llm, db: w.db, wtRoot: w.wtRoot,
      acceptanceDir: w.acceptanceDir, testCmd: "bun test --timeout 60000", seed: 1, buildMerge: true, agentDone: () => false, log: (l) => lines.push(l),
      gradeRunner: (cwd: string, cmd: string, _t: number, kind: StepKind) => {
        const side = readFileSync(join(cwd, "answer-T1.txt"), "utf8").includes("old") ? "old" : "new";
        const out = outfile(cmd);
        if (kind === "suite") {
          // old: two files fail, one of which passes on retry; new: killed, no JUnit at all.
          if (side === "old" && out) writeFileSync(out, junit(["tests/flaky.test.ts", "tests/real.test.ts"]));
          return false;
        }
        if (kind === "retry") {
          if (out) writeFileSync(out, junit(["tests/real.test.ts"]));
          return false;
        }
        if (kind === "hidden" && out) writeFileSync(out, `<?xml version="1.0"?><testsuites><testsuite name="check" file="check-T1.sh"><testcase name="ok"/></testsuite></testsuites>`);
        return true;
      },
    });
    expect(lines).toContain("forward: T1: old suite failed: tests/real.test.ts");
    expect(lines).toContain("forward: T1: new suite failed: no JUnit (killed, timed out or crashed)");
  }, 90_000);

  test("a passing suite logs nothing", async () => {
    const w = makeWorld(["T1"]);
    const lines: string[] = [];
    await runForward({
      repo: w.repo, backlog: w.backlog, pair: { old: "A", new: "B" }, parallel: 1, harness, llm, db: w.db, wtRoot: w.wtRoot,
      acceptanceDir: w.acceptanceDir, testCmd: "sh suite.sh", seed: 1, buildMerge: true, agentDone: () => false, log: (l) => lines.push(l),
      gradeRunner: () => true,
    });
    expect(lines.filter((l) => l.includes("suite failed"))).toEqual([]);
  }, 60_000);
});

describe("re-merge grading slots", () => {
  for (const slots of [1, 2]) {
    test(`a regrade never grades more than ${slots} branch${slots > 1 ? "es" : ""} at once, and logs failed suites`, async () => {
      const w = makeWorld(["T1", "T2"]);
      // Record two both-fail pairs (every suite fails), then regrade them with a counting runner.
      await runForward({
        repo: w.repo, backlog: w.backlog, pair: { old: "A", new: "B" }, parallel: 1, harness, llm, db: w.db, wtRoot: w.wtRoot,
        acceptanceDir: w.acceptanceDir, testCmd: "sh suite.sh", seed: 1, buildMerge: true, agentDone: () => false,
        gradeRunner: (_c: string, _cmd: string, _t: number, kind: StepKind) => kind !== "suite" && kind !== "retry",
      });
      let inFlight = 0;
      let most = 0;
      const lines: string[] = [];
      const res = await remergeForward({
        repo: w.repo, backlog: w.backlog, llm, db: w.db, testCmd: "sh suite.sh", acceptanceDir: w.acceptanceDir, regrade: true, parallel: 2,
        gradeParallel: slots, log: (l) => lines.push(l),
        gradeRunner: async (_c: string, _cmd: string, _t: number, kind: StepKind) => {
          most = Math.max(most, ++inFlight);
          await Bun.sleep(30);
          inFlight--;
          return kind !== "suite";
        },
      });
      expect(res.revisited).toHaveLength(2);
      expect(most).toBe(slots);
      expect(lines.filter((l) => l.endsWith("suite failed: no JUnit (killed, timed out or crashed)")).length).toBe(4);
    }, 120_000);
  }
});

describe("regrading a merged pair (H1 only)", () => {
  test("recomputes H1 when named with --tasks, keeps the merge, and adds no merge commit", async () => {
    const w = makeWorld(["T1"]);
    const sideOf = (cwd: string) => (readFileSync(join(cwd, "answer-T1.txt"), "utf8").includes("old") ? "old" : "new");
    // Both pass acceptance; old's suite "fails" (as under overload), so H1 is old fail / new pass and new merges.
    const first = await runForward({
      repo: w.repo, backlog: w.backlog, pair: { old: "A", new: "B" }, parallel: 1, harness, llm, db: w.db, wtRoot: w.wtRoot,
      acceptanceDir: w.acceptanceDir, testCmd: "sh suite.sh", seed: 1, buildMerge: true, agentDone: () => false,
      gradeRunner: (cwd: string, _cmd: string, _t: number, kind: StepKind) => !(kind === "suite" && sideOf(cwd) === "old"),
    });
    expect(first.completed[0]).toMatchObject({ pass_old: false, pass_new: true, merged: "new" });
    const head = runGit(w.repo, ["rev-parse", "HEAD"]);

    // A plain remerge (no --tasks) leaves merged pairs alone.
    const plain = await remergeForward({ repo: w.repo, backlog: w.backlog, llm, db: w.db, testCmd: "sh suite.sh", acceptanceDir: w.acceptanceDir, regrade: true, gradeRunner: () => true });
    expect(plain.revisited).toEqual([]);

    const lines: string[] = [];
    const res = await remergeForward({
      repo: w.repo, backlog: w.backlog, llm, db: w.db, testCmd: "sh suite.sh", acceptanceDir: w.acceptanceDir, regrade: true, tasks: ["T1"],
      log: (l) => lines.push(l), gradeRunner: () => true,
    });
    expect(res.revisited[0]).toMatchObject({ pass_old: true, pass_new: true, merged: "new", suite_pass_old: true, suite_pass_new: true });
    expect(new ForwardStore(w.db).pairs()[0]).toMatchObject({ pass_old: true, pass_new: true, merged: "new" });
    expect(runGit(w.repo, ["rev-parse", "HEAD"])).toBe(head);
    expect(lines).toContain("forward: regrade T1: H1 old fail -> pass, new pass -> pass (merge kept: new)");
  }, 120_000);

  test("grades a merged pair from where its two branches meet, not from HEAD", async () => {
    const w = makeWorld(["T1"]);
    await runForward({
      repo: w.repo, backlog: w.backlog, pair: { old: "A", new: "B" }, parallel: 1, harness, llm, db: w.db, wtRoot: w.wtRoot,
      acceptanceDir: w.acceptanceDir, testCmd: "sh suite.sh", seed: 1, buildMerge: true, agentDone: () => false, gradeRunner: () => true,
    });
    // Acceptance greps the side's own answer: graded from HEAD, the merged side's change would vanish from its diff.
    const seen: string[] = [];
    await remergeForward({
      repo: w.repo, backlog: w.backlog, llm, db: w.db, testCmd: "sh suite.sh", acceptanceDir: w.acceptanceDir, regrade: true, tasks: ["T1"],
      gradeRunner: (cwd: string, _cmd: string, _t: number, kind: StepKind) => {
        if (kind === "hidden") seen.push(readFileSync(join(cwd, "answer-T1.txt"), "utf8").trim());
        return true;
      },
    });
    expect(seen.sort()).toEqual(["ok new", "ok old"]);
  }, 120_000);
});
