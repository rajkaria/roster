import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusyClock, type Harness, runForward, Slots } from "../src/forward/index.ts";
import type { StepKind } from "../src/grade/index.ts";
import type { LlmClient } from "../src/llm/types.ts";
import { runGit } from "../src/sandbox/index.ts";

// Amendment 13: a pair grading never stalls the rest of the queue, grading runs through slots, and grade_ms counts
// only time spent grading.

const IDS = ["T1", "T2"] as const;

function makeWorld() {
  const root = mkdtempSync(join(tmpdir(), "roster-asyncgrade-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "suite.sh"), "true\n");
  runGit(repo, ["init", "-q", "-b", "main"]);
  runGit(repo, ["add", "-A"]);
  runGit(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"]);
  let backlog = "";
  for (const id of IDS) {
    const acceptance = join(root, "acceptance", id);
    mkdirSync(acceptance, { recursive: true });
    writeFileSync(join(acceptance, `check-${id}.sh`), `grep -q ok answer-${id}.txt\n`);
    backlog += `<!-- ${id} -->\n[roster setup=X task=${id}]\nWrite ok.\nOWNS: answer-${id}.txt\n<!-- /${id} -->\n`;
  }
  return { root, repo, backlog, acceptanceDir: join(root, "acceptance") };
}

/** Each side writes its task's answer after `before(task id)` resolves. */
const harnessWith = (before: (id: string) => Promise<void> = async () => undefined): Harness => async (req) => {
  await before(req.task.id);
  writeFileSync(join(req.worktree, `answer-${req.task.id}.txt`), `ok ${req.side}\n`);
  runGit(req.worktree, ["add", "-A"]);
  runGit(req.worktree, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", `${req.task.id}: ${req.side}`]);
  return { costUsd: 0.1 };
};

/** The grading copy's task: the answer file its change added. */
const taskOf = (cwd: string) => (existsSync(join(cwd, "answer-T2.txt")) ? "T2" : "T1");

const llm: LlmClient = {
  async chat() {
    return { message: { role: "assistant", content: "verdict: X" }, toolCalls: [], usage: { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 }, costUsd: 0, model: "fake" };
  },
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("forward queue with asynchronous grading", () => {
  test("a pair's agents start and finish while another pair is grading", async () => {
    const w = makeWorld();
    const t1Grading = deferred();
    const t2AgentsDone = deferred();
    let t2Sides = 0;
    const order: string[] = [];
    const summary = await runForward({
      repo: w.repo, backlog: w.backlog, pair: { old: "A", new: "B" }, parallel: 2, llm,
      db: join(w.root, "s.db"), wtRoot: join(w.root, "wt"), acceptanceDir: w.acceptanceDir, testCmd: "sh suite.sh", seed: 1,
      // T2's agents only run once T1 is grading; T1's first grading step only returns once T2's agents are done.
      // A blocking grading step would deadlock here.
      harness: harnessWith(async (id) => {
        if (id !== "T2") return;
        await t1Grading.promise;
        order.push("T2 agent");
        if (++t2Sides === 2) setTimeout(t2AgentsDone.resolve, 0);
      }),
      gradeRunner: async (cwd: string, _cmd: string, _t: number, _kind: StepKind) => {
        if (taskOf(cwd) === "T1") {
          order.push("T1 grading");
          t1Grading.resolve();
          await t2AgentsDone.promise;
        }
        return true;
      },
    });
    expect(summary.completed.map((p) => p.task_id).sort()).toEqual(["T1", "T2"]);
    expect(order.slice(0, 3)).toEqual(["T1 grading", "T2 agent", "T2 agent"]);
    for (const p of summary.completed) expect(p.grade_ms!).toBeGreaterThanOrEqual(0);
  }, 60_000);

  for (const slots of [1, 2]) {
    test(`grading never holds more than ${slots} slot${slots > 1 ? "s" : ""} across pairs`, async () => {
      const w = makeWorld();
      let inFlight = 0;
      let most = 0;
      const summary = await runForward({
        repo: w.repo, backlog: w.backlog, pair: { old: "A", new: "B" }, parallel: 2, llm, harness: harnessWith(),
        db: join(w.root, "s.db"), wtRoot: join(w.root, "wt"), acceptanceDir: w.acceptanceDir, testCmd: "sh suite.sh", seed: 1,
        gradeParallel: slots,
        gradeRunner: async () => {
          most = Math.max(most, ++inFlight);
          await Bun.sleep(40);
          inFlight--;
          return true;
        },
      });
      expect(summary.completed).toHaveLength(2);
      expect(most).toBe(slots);
    }, 60_000);
  }

});

describe("grading slots and the pair's grading clock", () => {
  test("Slots runs at most n at once, in order", async () => {
    const slots = new Slots(2);
    let inFlight = 0;
    let most = 0;
    const started: number[] = [];
    await Promise.all(
      [0, 1, 2, 3, 4].map((i) =>
        slots.run(async () => {
          started.push(i);
          most = Math.max(most, ++inFlight);
          await Bun.sleep(20);
          inFlight--;
        }),
      ),
    );
    expect(most).toBe(2);
    expect(started).toEqual([0, 1, 2, 3, 4]);
  });

  test("Slots frees its slot when the function throws", async () => {
    const slots = new Slots(1);
    await expect(slots.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await slots.run(() => 7)).toBe(7);
  });

  test("BusyClock counts overlapping steps once and a wait for a slot not at all", async () => {
    const slots = new Slots(1);
    const other = new BusyClock();
    const mine = new BusyClock();
    // Another pair holds the only slot for 300 ms; this pair's two 100 ms steps wait behind it, then run in turn.
    const hold = slots.run(() => other.time(() => Bun.sleep(300)));
    await Bun.sleep(5);
    await Promise.all([slots.run(() => mine.time(() => Bun.sleep(100))), slots.run(() => mine.time(() => Bun.sleep(100)))]);
    await hold;
    expect(other.ms).toBeGreaterThanOrEqual(290);
    expect(mine.ms).toBeGreaterThanOrEqual(190);
    expect(mine.ms).toBeLessThan(290);

    const overlap = new BusyClock();
    await Promise.all([overlap.time(() => Bun.sleep(100)), overlap.time(() => Bun.sleep(100))]);
    expect(overlap.ms).toBeGreaterThanOrEqual(95);
    expect(overlap.ms).toBeLessThan(190);
  });
});
