import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseForwardArgs } from "../src/cli/forward.ts";
import { UsageError } from "../src/cli/review.ts";
import {
  blindMessages,
  chooseMerge,
  evaluateStopRule,
  type Harness,
  parseBacklog,
  parseVerdict,
  pairSeed,
  rng,
  runForward,
  type RevertRequest,
} from "../src/forward/index.ts";
import type { ChatMessage, LlmClient } from "../src/llm/types.ts";
import { gitEnv, runGit } from "../src/sandbox/index.ts";
import type { ForwardPair } from "../src/types.ts";

const OLD = "setupA";
const NEW = "setupB";

const SUITE = 'for f in check-*.sh; do [ -e "$f" ] || continue; sh "$f" || exit 1; done\n';

type Outcome = "pass" | "fail" | "scope";

/** A repo with a stub suite, plus a backlog of n tasks. Acceptance for Tn checks that answer-Tn.txt says ok. */
function makeWorld(n: number) {
  const root = mkdtempSync(join(tmpdir(), "roster-forward-test-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "acceptance"), { recursive: true });
  writeFileSync(join(repo, "suite.sh"), SUITE);
  runGit(repo, ["init", "-q", "-b", "main"]);
  runGit(repo, ["add", "-A"]);
  runGit(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"]);
  const acceptance = join(root, "acceptance");
  let backlog = "";
  for (let i = 1; i <= n; i++) {
    const id = `T${i}`;
    backlog += `<!-- ${id} -->\n[roster setup=X task=${id}]\nWrite ok into answer-${id}.txt.\nOWNS: answer-${id}.txt\n<!-- /${id} -->\n`;
    mkdirSync(join(acceptance, id), { recursive: true });
    writeFileSync(join(acceptance, id, `check-${id}.sh`), `grep -q ok answer-${id}.txt\n`);
  }
  return { root, repo, acceptance, backlog };
}

/** A harness that follows a script: per task and side, pass / fail / scope (an off-scope edit). */
function scripted(script: (task: string, side: "old" | "new") => Outcome): { harness: Harness; seen: string[] } {
  const seen: string[] = [];
  const harness: Harness = async (req) => {
    seen.push(`${req.task.id}:${req.side}`);
    const out = script(req.task.id, req.side);
    writeFileSync(join(req.worktree, `answer-${req.task.id}.txt`), out === "fail" ? "bad\n" : "ok\n");
    if (out === "scope") writeFileSync(join(req.worktree, "stray.txt"), "off scope\n");
    runGit(req.worktree, ["add", "-A"]);
    runGit(req.worktree, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", `${req.task.id}: ${req.side}`]);
    return { costUsd: req.side === "old" ? 0.5 : 0.25 };
  };
  return { harness, seen };
}

/** A judge that answers from a list and keeps every input it was shown. */
function judge(answers: string[]) {
  const inputs: ChatMessage[][] = [];
  let i = 0;
  const llm: LlmClient = {
    async chat(req) {
      inputs.push(req.messages);
      const content = `verdict: ${answers[i++ % answers.length]}`;
      return { message: { role: "assistant", content }, toolCalls: [], usage: { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 }, costUsd: 0, model: "fake" };
    },
  };
  return { llm, inputs };
}

let saved: Record<string, string | undefined>;
beforeAll(() => {
  saved = { ...process.env };
  Object.assign(process.env, gitEnv(), { GIT_AUTHOR_DATE: undefined, GIT_COMMITTER_DATE: undefined });
  delete process.env.GIT_AUTHOR_DATE;
  delete process.env.GIT_COMMITTER_DATE;
});
afterAll(() => {
  process.env = saved as typeof process.env;
});

describe("pure pieces", () => {
  test("parseBacklog reads blocks and OWNS", () => {
    const t = parseBacklog("<!-- T1 -->\n[roster setup=A task=T1]\nDo it.\nOWNS: src/a.ts, tests/a.test.ts\n<!-- /T1 -->\n<!-- T2 -->\nOther\n<!-- /T2 -->\n");
    expect(t.map((x) => x.id)).toEqual(["T1", "T2"]);
    expect(t[0]!.body).not.toContain("[roster");
    expect(t[0]!.owns).toEqual(["src/a.ts", "tests/a.test.ts"]);
    expect(t[1]!.owns).toEqual([]);
  });

  test("merge policy: pass beats fail, judge decides ties, a seeded pick breaks judge ties", () => {
    const r = rng(1);
    expect(chooseMerge({ old: true, new: false }, "new", r)).toEqual({ merged: "old", reason: "pass_beats_fail" });
    expect(chooseMerge({ old: false, new: true }, null, r).merged).toBe("new");
    expect(chooseMerge({ old: false, new: false }, null, r).merged).toBeNull();
    expect(chooseMerge({ old: true, new: true }, "new", r)).toEqual({ merged: "new", reason: "judge" });
    const a = chooseMerge({ old: true, new: true }, null, rng(7));
    expect(a.reason).toBe("random_tie");
    expect(chooseMerge({ old: true, new: true }, null, rng(7))).toEqual(a);
    expect(pairSeed(1, "T1")).toBe(pairSeed(1, "T1"));
    expect(pairSeed(1, "T1")).not.toBe(pairSeed(1, "T2"));
  });

  test("verdict parsing", () => {
    expect(parseVerdict("reasoning...\nverdict: Y")).toBe("Y");
    expect(parseVerdict("verdict: tie")).toBe("tie");
    expect(parseVerdict("no idea")).toBe("tie");
  });

  test("stop rule needs 15 pairs and a net loss of 3", () => {
    const pair = (i: number, o: boolean, n: boolean): ForwardPair => ({
      task_id: `T${i}`, setup_old: OLD, setup_new: NEW, pass_old: o, pass_new: n, cost_old: null, cost_new: null, merged: null, blind_labels: {}, seed: 0,
    });
    const losing = Array.from({ length: 14 }, (_, i) => pair(i, true, i >= 3));
    expect(evaluateStopRule(losing)).toMatchObject({ lost: 3, won: 0, triggered: false });
    expect(evaluateStopRule([...losing, pair(99, true, true)]).triggered).toBe(true);
    // 4 lost, 1 won: net 3
    const mixed = [pair(0, true, false), pair(1, true, false), pair(2, true, false), pair(3, true, false), pair(4, false, true), ...Array.from({ length: 10 }, (_, i) => pair(10 + i, true, true))];
    expect(evaluateStopRule(mixed).triggered).toBe(true);
    // 3 lost, 1 won: net 2
    expect(evaluateStopRule(mixed.slice(1)).triggered).toBe(false);
  });

  test("args", () => {
    expect(parseForwardArgs(["--backlog", "b.md", "--pair", "A,B"])).toMatchObject({ backlog: "b.md", old: "A", new: "B", parallel: 4 });
    expect(parseForwardArgs(["--backlog=b.md", "--pair=A,B", "--parallel=2"]).parallel).toBe(2);
    expect(() => parseForwardArgs(["--pair", "A,B"])).toThrow(UsageError);
    expect(() => parseForwardArgs(["--backlog", "b", "--pair", "A"])).toThrow(UsageError);
    expect(() => parseForwardArgs(["--backlog", "b", "--pair", "A,B", "--parallel", "0"])).toThrow(UsageError);
  });
});

describe("forward run with a stub harness", () => {
  test("6 pairs complete, merges follow the policy, the judge input is blind", async () => {
    const w = makeWorld(6);
    try {
      const outcomes: Record<string, [Outcome, Outcome]> = {
        T1: ["pass", "pass"],
        T2: ["pass", "fail"],
        T3: ["fail", "pass"],
        T4: ["fail", "fail"],
        T5: ["pass", "pass"],
        T6: ["pass", "scope"],
      };
      const { harness } = scripted((t, s) => outcomes[t]![s === "old" ? 0 : 1]);
      const j = judge(["X", "Y", "tie"]);
      const res = await runForward({
        repo: w.repo, backlog: w.backlog, pair: { old: OLD, new: NEW }, parallel: 3, harness, llm: j.llm,
        db: join(w.root, "state.db"), wtRoot: join(w.root, "wt"), acceptanceDir: w.acceptance, testCmd: "sh suite.sh", seed: 42,
      });
      expect(res.completed).toHaveLength(6);
      const by = Object.fromEntries(res.completed.map((p) => [p.task_id, p]));
      expect([by.T1!.pass_old, by.T1!.pass_new]).toEqual([true, true]);
      expect(by.T2).toMatchObject({ pass_old: true, pass_new: false, merged: "old" });
      expect(by.T3).toMatchObject({ pass_old: false, pass_new: true, merged: "new" });
      expect(by.T4).toMatchObject({ pass_old: false, pass_new: false, merged: null });
      expect(by.T6).toMatchObject({ pass_old: true, pass_new: false, merged: "old" }); // off-scope edit fails the scope guard
      expect(by.T2!.cost_old).toBe(0.5);
      expect(by.T2!.cost_new).toBe(0.25);

      // Judge ran only for the two both-pass pairs, and saw no setup names or side words.
      expect(j.inputs).toHaveLength(2);
      for (const input of j.inputs) {
        const text = input.map((m) => m.content).join("\n");
        expect(text).not.toContain(OLD);
        expect(text).not.toContain(NEW);
        expect(text).not.toContain("forward/");
        expect(text).toContain("=== Change X ===");
        expect(text).toContain("=== Change Y ===");
      }
      // Both-pass merges follow the judge's mapping back through the labels (or the seeded pick on a tie).
      for (const id of ["T1", "T5"]) {
        const p = by[id]!;
        expect(Object.values(p.blind_labels).sort()).toEqual(["new", "old"]);
        expect(p.merged).not.toBeNull();
        expect(p.seed).toBe(pairSeed(42, id));
      }

      const log = runGit(w.repo, ["log", "--merges", "--format=%s"]).split("\n");
      expect(log).toHaveLength(5); // T1, T2, T3, T5 and T6 merged; T4 (both failed) did not
    } finally {
      rmSync(w.root, { recursive: true, force: true });
    }
  }, 120_000);

  test("resumes: finished pairs are not rerun", async () => {
    const w = makeWorld(2);
    try {
      const a = scripted(() => "pass");
      const j = judge(["X"]);
      const base = { repo: w.repo, backlog: w.backlog, pair: { old: OLD, new: NEW }, llm: j.llm, db: join(w.root, "s.db"), wtRoot: join(w.root, "wt"), acceptanceDir: w.acceptance, testCmd: "sh suite.sh", seed: 1 };
      await runForward({ ...base, harness: a.harness, parallel: 1 });
      expect(a.seen).toHaveLength(4);
      const b = scripted(() => "pass");
      const res = await runForward({ ...base, harness: b.harness, parallel: 1 });
      expect(b.seen).toHaveLength(0);
      expect(res.skipped).toEqual(["T1", "T2"]);
    } finally {
      rmSync(w.root, { recursive: true, force: true });
    }
  }, 120_000);

  test("the stop rule fires on a scripted losing sequence, then work continues on OLD", async () => {
    const w = makeWorld(17);
    try {
      // NEW fails T1-T3 where OLD passes: after 15 pairs NEW is 3 down, so T16 and T17 run on OLD alone.
      const { harness, seen } = scripted((t, s) => (s === "new" && ["T1", "T2", "T3"].includes(t) ? "fail" : "pass"));
      const reverts: RevertRequest[] = [];
      const res = await runForward({
        repo: w.repo, backlog: w.backlog, pair: { old: OLD, new: NEW }, parallel: 1, harness, llm: judge(["X", "Y"]).llm,
        db: join(w.root, "state.db"), wtRoot: join(w.root, "wt"), acceptanceDir: w.acceptance, testCmd: "sh suite.sh", seed: 3,
        openRevertPr: async (r) => (reverts.push(r), { url: "https://example.invalid/pr/1", stub: false }),
      });
      expect(res.completed).toHaveLength(15);
      expect(res.stop).toMatchObject({ pairs: 15, lost: 3, won: 0, triggered: true });
      expect(reverts).toHaveLength(1);
      expect(reverts[0]).toMatchObject({ setupOld: OLD, setupNew: NEW });
      expect(res.soloOnOld).toEqual(["T16", "T17"]);
      expect(seen.filter((s) => s.startsWith("T16") || s.startsWith("T17"))).toEqual(["T16:old", "T17:old"]);
    } finally {
      rmSync(w.root, { recursive: true, force: true });
    }
  }, 300_000);
});

test("blindMessages hides setup ids even inside diffs", () => {
  const m = blindMessages("task", `+ // written by ${OLD}`, "+ y", [OLD, NEW]);
  expect(m.map((x) => x.content).join("")).not.toContain(OLD);
});
