// Amendment 12: the forward grader's step timeout and per-test timeout, the macOS-safe grading copy, the one-shot
// retry of failing suite files, per-pair error isolation, resume of finished agents, and --regrade.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORWARD_STEP_TIMEOUT_MS, ForwardStore, forwardTestCmd, type Harness, remergeForward, runForward } from "../src/forward/index.ts";
import { copyTree, failingTestFiles, grade, type StepKind } from "../src/grade/index.ts";
import type { LlmClient } from "../src/llm/types.ts";
import { createSandbox, runGit } from "../src/sandbox/index.ts";

const commit = (dir: string, msg: string) => runGit(dir, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", msg]);

function makeWorld(ids: string[] = ["T1"]) {
  const root = mkdtempSync(join(tmpdir(), "roster-gradefix-"));
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

const writeAnswer = (worktree: string, id: string, text: string) => {
  writeFileSync(join(worktree, `answer-${id}.txt`), text);
  runGit(worktree, ["add", "-A"]);
  commit(worktree, `${id}: answer`);
};

/** Each side writes its answer; old says "bad", new says "ok". */
const harness: Harness = async (req) => {
  writeAnswer(req.worktree, req.task.id, req.side === "old" ? "bad\n" : "ok new\n");
  return { costUsd: 0.1 };
};

const llm: LlmClient = {
  async chat() {
    return { message: { role: "assistant", content: "verdict: X" }, toolCalls: [], usage: { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 }, costUsd: 0, model: "fake" };
  },
};

/** Acceptance reads the answer file; the suite result is up to the caller. */
const runnerWith = (suite: boolean, seen?: { kind: StepKind; timeout: number }[]) => (cwd: string, _cmd: string, timeout: number, kind: StepKind) => {
  seen?.push({ kind, timeout });
  if (kind === "hidden") {
    const f = readFileSync(join(cwd, "answer-T1.txt"), "utf8");
    return f.includes("ok");
  }
  return kind === "suite" || kind === "retry" ? suite : true;
};

const JUNIT = (cases: { file: string; fail?: boolean; skip?: boolean }[]) =>
  `<?xml version="1.0"?><testsuites>${cases
    .map((c, i) => `<testsuite name="${c.file}" file="${c.file}"><testcase name="t${i}"${c.fail || c.skip ? `>${c.fail ? "<failure/>" : "<skipped/>"}</testcase>` : "/>"}</testsuite>`)
    .join("")}</testsuites>`;

describe("grading helpers", () => {
  test("failingTestFiles lists files with failures, not skips, once each", () => {
    const xml = JUNIT([{ file: "tests/a.test.ts", fail: true }, { file: "tests/a.test.ts", fail: true }, { file: "tests/b.test.ts", skip: true }, { file: "./tests/c.test.ts", fail: true }, { file: "tests/d.test.ts" }]);
    expect(failingTestFiles(xml)).toEqual(["tests/a.test.ts", "tests/c.test.ts"]);
  });

  test("forwardTestCmd gives bun a 60 s per-test timeout and leaves undetectable trees to grade()", () => {
    const d = mkdtempSync(join(tmpdir(), "roster-cmd-"));
    expect(forwardTestCmd(d)).toBeUndefined();
    writeFileSync(join(d, "bun.lock"), "");
    expect(forwardTestCmd(d)).toBe("bun test --timeout 60000");
  });

  test("copyTree copies history (git objects included) and fails loudly on a bad source", () => {
    const src = mkdtempSync(join(tmpdir(), "roster-copy-src-"));
    writeFileSync(join(src, "a.txt"), "a\n");
    runGit(src, ["init", "-q", "-b", "main"]);
    runGit(src, ["add", "-A"]);
    commit(src, "one");
    const sha = runGit(src, ["rev-parse", "HEAD"]);
    if (process.platform === "darwin") Bun.spawnSync(["xattr", "-w", "com.roster.test", "x", join(src, "a.txt")]);
    const dst = join(mkdtempSync(join(tmpdir(), "roster-copy-dst-")), "work");
    copyTree(src, dst);
    expect(runGit(dst, ["cat-file", "-t", sha])).toBe("commit");
    expect(readFileSync(join(dst, "a.txt"), "utf8")).toBe("a\n");
    expect(() => copyTree(join(src, "missing"), join(dst, "..", "w2"))).toThrow(/copy failed/);
  });

  test("a failing suite re-runs only its failing files, once; more than 5 failing files is a real failure", async () => {
    const repo = mkdtempSync(join(tmpdir(), "roster-retry-"));
    writeFileSync(join(repo, "x.txt"), "x\n");
    runGit(repo, ["init", "-q", "-b", "main"]);
    runGit(repo, ["add", "-A"]);
    commit(repo, "base");
    const run = async (failing: string[], retryPasses: boolean) => {
      const sandbox = await createSandbox(repo, runGit(repo, ["rev-parse", "HEAD"]), { root: mkdtempSync(join(tmpdir(), "roster-sb-")) });
      const cmds: { kind: StepKind; cmd: string }[] = [];
      const r = await grade({
        sandbox, hidden: [], preexistingTests: [], testCmd: "bun test", phase: "suite",
        runner: (_cwd, cmd, _t, kind) => {
          cmds.push({ kind, cmd });
          if (kind === "suite") {
            const out = /--reporter-outfile=(\S+)/.exec(cmd)![1]!;
            writeFileSync(out, JUNIT([...failing.map((file) => ({ file, fail: true })), { file: "tests/ok.test.ts" }]));
            return false;
          }
          return retryPasses;
        },
      });
      return { r, cmds };
    };
    const one = await run(["tests/flaky.test.ts"], true);
    expect(one.r.suitePass).toBe(true);
    const retry = one.cmds.filter((c) => c.kind === "retry");
    expect(retry).toHaveLength(1);
    expect(retry[0]!.cmd).toContain('"tests/flaky.test.ts"');
    expect(retry[0]!.cmd).not.toContain("tests/ok.test.ts");

    expect((await run(["tests/flaky.test.ts"], false)).r.suitePass).toBe(false);
    const many = await run(["a", "b", "c", "d", "e", "f"].map((n) => `tests/${n}.test.ts`), true);
    expect(many.r.suitePass).toBe(false);
    expect(many.cmds.filter((c) => c.kind === "retry")).toHaveLength(0);
  });
});

describe("forward run robustness", () => {
  test("every grading step gets the forward timeout", async () => {
    const w = makeWorld();
    const seen: { kind: StepKind; timeout: number }[] = [];
    await runForward({
      repo: w.repo, backlog: w.backlog, pair: { old: "A", new: "B" }, parallel: 1, harness, llm, db: w.db, wtRoot: w.wtRoot,
      acceptanceDir: w.acceptanceDir, testCmd: "sh suite.sh", seed: 1, gradeRunner: runnerWith(true, seen), buildMerge: true, agentDone: () => false,
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(FORWARD_STEP_TIMEOUT_MS).toBeGreaterThanOrEqual(30 * 60_000);
    expect(seen.every((s) => s.timeout === FORWARD_STEP_TIMEOUT_MS)).toBe(true);
  }, 60_000);

  test("a pair that throws is reported and the run goes on to the next task", async () => {
    const w = makeWorld(["T1", "T2"]);
    const flaky: Harness = async (req) => {
      if (req.task.id === "T1") throw new Error("launch failed");
      writeAnswer(req.worktree, req.task.id, "ok\n");
      return { costUsd: 0.1 };
    };
    const s = await runForward({
      repo: w.repo, backlog: w.backlog, pair: { old: "A", new: "B" }, parallel: 1, harness: flaky, llm, db: w.db, wtRoot: w.wtRoot,
      acceptanceDir: w.acceptanceDir, testCmd: "sh suite.sh", seed: 1, gradeRunner: () => true, buildMerge: true, agentDone: () => false,
    });
    expect(s.errored).toEqual(["T1"]);
    expect(s.completed.map((p) => p.task_id)).toEqual(["T2"]);
    expect(new ForwardStore(w.db).pairs().map((p) => p.task_id)).toEqual(["T2"]);
  }, 60_000);

  test("finished agents from an earlier run are graded from their branches, not re-run", async () => {
    const w = makeWorld();
    const base = runGit(w.repo, ["rev-parse", "HEAD"]);
    for (const side of ["old", "new"] as const) {
      const wt = join(w.wtRoot, side, "T1");
      mkdirSync(join(w.wtRoot, side), { recursive: true });
      runGit(w.repo, ["worktree", "add", "-q", wt, "-b", `forward/T1/${side}`, base]);
      writeAnswer(wt, "T1", side === "old" ? "bad\n" : "ok new\n");
    }
    // main moves on meanwhile: the pair's base must still be where the two branches meet.
    writeFileSync(join(w.repo, "later.txt"), "later\n");
    runGit(w.repo, ["add", "-A"]);
    commit(w.repo, "later");
    let launched = 0;
    const s = await runForward({
      repo: w.repo, backlog: w.backlog, pair: { old: "A", new: "B" }, parallel: 1, llm, db: w.db, wtRoot: w.wtRoot,
      harness: async () => {
        launched++;
        return { costUsd: null };
      },
      acceptanceDir: w.acceptanceDir, testCmd: "sh suite.sh", seed: 1, gradeRunner: runnerWith(true), buildMerge: true, agentDone: () => true,
    });
    expect(launched).toBe(0);
    expect(s.resumed).toEqual(["T1"]);
    expect(s.completed[0]).toMatchObject({ pass_old: false, pass_new: true, merged: "new", agent_old_ms: null, agent_new_ms: null });
  }, 60_000);

  test("a half-run pair is discarded and starts clean from the current main", async () => {
    const w = makeWorld();
    const base = runGit(w.repo, ["rev-parse", "HEAD"]);
    const wt = join(w.wtRoot, "old", "T1");
    mkdirSync(join(w.wtRoot, "old"), { recursive: true });
    runGit(w.repo, ["worktree", "add", "-q", wt, "-b", "forward/T1/old", base]);
    writeAnswer(wt, "T1", "stale partial work\n");
    writeFileSync(join(w.repo, "later.txt"), "later\n");
    runGit(w.repo, ["add", "-A"]);
    commit(w.repo, "later");
    const head = runGit(w.repo, ["rev-parse", "HEAD"]);
    let launched = 0;
    const s = await runForward({
      repo: w.repo, backlog: w.backlog, pair: { old: "A", new: "B" }, parallel: 1, llm, db: w.db, wtRoot: w.wtRoot,
      harness: async (req) => {
        launched++;
        expect(runGit(req.worktree, ["rev-parse", "HEAD"])).toBe(head);
        expect(existsSync(join(req.worktree, "answer-T1.txt"))).toBe(false);
        return harness(req);
      },
      acceptanceDir: w.acceptanceDir, testCmd: "sh suite.sh", seed: 1, gradeRunner: runnerWith(true), buildMerge: true, agentDone: () => false,
    });
    expect(launched).toBe(2);
    expect(s.resumed).toEqual([]);
    expect(s.completed).toHaveLength(1);
  }, 60_000);

  test("--regrade recomputes H1 for a pair graded while every suite run failed, and merges it", async () => {
    const w = makeWorld();
    const first = await runForward({
      repo: w.repo, backlog: w.backlog, pair: { old: "A", new: "B" }, parallel: 1, harness, llm, db: w.db, wtRoot: w.wtRoot,
      acceptanceDir: w.acceptanceDir, testCmd: "sh suite.sh", seed: 1, gradeRunner: runnerWith(false), buildMerge: true, agentDone: () => false,
    });
    // The broken grader: new passed acceptance but its suite "failed", so H1 is fail on both sides and nothing merged.
    expect(first.completed[0]).toMatchObject({ pass_old: false, pass_new: false, merged: null });

    const plain = await remergeForward({ repo: w.repo, backlog: w.backlog, llm, db: w.db, testCmd: "sh suite.sh", acceptanceDir: w.acceptanceDir, gradeRunner: runnerWith(true), tasks: ["T1"] });
    // Remerge alone keeps the recorded H1 (fail/fail) even though it can now merge on suite and scope.
    expect(plain.revisited[0]).toMatchObject({ pass_old: false, pass_new: false });
    runGit(w.repo, ["reset", "-q", "--hard", "HEAD~1"]);
    new ForwardStore(w.db).updateMerge({ ...plain.revisited[0]!, merged: null });

    const lines: string[] = [];
    const res = await remergeForward({
      repo: w.repo, backlog: w.backlog, llm, db: w.db, testCmd: "sh suite.sh", acceptanceDir: w.acceptanceDir, gradeRunner: runnerWith(true), regrade: true, log: (l) => lines.push(l),
    });
    expect(res.revisited[0]).toMatchObject({ pass_old: false, pass_new: true, merged: "new", merged_reason: "pass_beats_fail" });
    expect(new ForwardStore(w.db).pairs()[0]).toMatchObject({ pass_old: false, pass_new: true, merged: "new" });
    expect(lines.some((l) => l.includes("regrade T1: H1 old fail -> fail, new fail -> pass"))).toBe(true);
  }, 90_000);

  test("one pair's grading error does not abort a remerge", async () => {
    const w = makeWorld(["T1", "T2"]);
    await runForward({
      repo: w.repo, backlog: w.backlog, pair: { old: "A", new: "B" }, parallel: 1, harness, llm, db: w.db, wtRoot: w.wtRoot,
      acceptanceDir: w.acceptanceDir, testCmd: "sh suite.sh", seed: 1, gradeRunner: () => false, buildMerge: true, agentDone: () => false,
    });
    const lines: string[] = [];
    const res = await remergeForward({
      repo: w.repo, backlog: w.backlog, llm, db: w.db, testCmd: "sh suite.sh", acceptanceDir: w.acceptanceDir, log: (l) => lines.push(l),
      gradeRunner: (cwd) => {
        if (existsSync(join(cwd, "answer-T1.txt"))) throw new Error("grader blew up");
        return true;
      },
    });
    // T1's grading throws; T2 is still revisited and merged.
    expect(res.skipped).toEqual(["T1"]);
    expect(res.revisited.map((p) => p.task_id)).toEqual(["T2"]);
    expect(res.revisited[0]!.merged).not.toBeNull();
    expect(lines.some((l) => l.includes("remerge T1: error, left as recorded: grader blew up"))).toBe(true);
  }, 90_000);
});

describe("grading does not block the event loop", () => {
  test("the default step runner is async: timers keep firing while a step runs", async () => {
    const repo = mkdtempSync(join(tmpdir(), "roster-async-"));
    writeFileSync(join(repo, "x.txt"), "x\n");
    runGit(repo, ["init", "-q", "-b", "main"]);
    runGit(repo, ["add", "-A"]);
    commit(repo, "base");
    const sandbox = await createSandbox(repo, runGit(repo, ["rev-parse", "HEAD"]), { root: mkdtempSync(join(tmpdir(), "roster-sb-")) });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);
    const r = await grade({ sandbox, hidden: [], preexistingTests: [], testCmd: "sleep 1.5", phase: "suite" });
    clearInterval(timer);
    expect(r.suitePass).toBe(true);
    // A blocking spawnSync would starve the timer for the whole 1.5 s.
    expect(ticks).toBeGreaterThanOrEqual(10);
  }, 30_000);
});
