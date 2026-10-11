import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseForwardArgs, secondaryLine } from "../src/cli/forward.ts";
import { UsageError } from "../src/cli/review.ts";
import {
  chooseMerge,
  ForwardStore,
  type Harness,
  remergeForward,
  rng,
  runForward,
  secondaryOutcome,
} from "../src/forward/index.ts";
import type { ChatMessage, LlmClient } from "../src/llm/types.ts";
import { gitEnv, runGit } from "../src/sandbox/index.ts";
import type { ForwardPair } from "../src/types.ts";

const OLD = "setupA";
const NEW = "setupB";

// The suite runs the repo's unit checks plus, at grading time, the acceptance checks dropped in next to them.
const SUITE = 'for f in unit-*.sh check-*.sh; do [ -e "$f" ] || continue; sh "$f" || exit 1; done\n';

/**
 * accept: passes acceptance, suite and scope. suite: fails acceptance, suite and scope ok.
 * broken: fails acceptance and breaks the suite. scope: fails acceptance, suite ok, edits off scope.
 */
type Outcome = "accept" | "suite" | "broken" | "scope";

function makeWorld(n: number) {
  const root = mkdtempSync(join(tmpdir(), "roster-forward-merge-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "suite.sh"), SUITE);
  runGit(repo, ["init", "-q", "-b", "main"]);
  runGit(repo, ["add", "-A"]);
  runGit(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"]);
  const acceptance = join(root, "acceptance");
  let backlog = "";
  for (let i = 1; i <= n; i++) {
    const id = `T${i}`;
    backlog += `<!-- ${id} -->\n[roster setup=X task=${id}]\nWrite ok into answer-${id}.txt.\nOWNS: answer-${id}.txt, unit-${id}.sh\n<!-- /${id} -->\n`;
    mkdirSync(join(acceptance, id), { recursive: true });
    writeFileSync(join(acceptance, id, `check-${id}.sh`), `grep -q ok answer-${id}.txt\n`);
  }
  return { root, repo, acceptance, backlog };
}

function scripted(script: (task: string, side: "old" | "new") => Outcome): Harness {
  return async (req) => {
    const out = script(req.task.id, req.side);
    const id = req.task.id;
    writeFileSync(join(req.worktree, `answer-${id}.txt`), out === "accept" ? "ok\n" : `${req.side} draft\n`);
    writeFileSync(join(req.worktree, `unit-${id}.sh`), out === "broken" ? "exit 1\n" : "exit 0\n");
    if (out === "scope") writeFileSync(join(req.worktree, `stray-${id}.txt`), "off scope\n");
    runGit(req.worktree, ["add", "-A"]);
    runGit(req.worktree, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", `${id}: ${req.side}`]);
    return { costUsd: null };
  };
}

function judge(answer: "X" | "Y" | "tie") {
  const inputs: ChatMessage[][] = [];
  const llm: LlmClient = {
    async chat(req) {
      inputs.push(req.messages);
      return { message: { role: "assistant", content: `verdict: ${answer}` }, toolCalls: [], usage: { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 }, costUsd: 0, model: "fake" };
    },
  };
  return { llm, inputs };
}

function opts(w: ReturnType<typeof makeWorld>, harness: Harness, llm: LlmClient, extra: { buildMerge?: boolean; db?: string; parallel?: number } = {}) {
  return {
    repo: w.repo, backlog: w.backlog, pair: { old: OLD, new: NEW }, parallel: extra.parallel ?? 4, harness, llm,
    db: extra.db ?? join(w.root, "state.db"), wtRoot: join(w.root, "wt"), acceptanceDir: w.acceptance, testCmd: "sh suite.sh", seed: 11,
    buildMerge: extra.buildMerge ?? true,
  };
}

const mergeSubjects = (repo: string) => runGit(repo, ["log", "--merges", "--format=%s"]).split("\n").filter(Boolean);

let saved: Record<string, string | undefined>;
beforeAll(() => {
  saved = { ...process.env };
  Object.assign(process.env, gitEnv());
  delete process.env.GIT_AUTHOR_DATE;
  delete process.env.GIT_COMMITTER_DATE;
});
afterAll(() => {
  process.env = saved as typeof process.env;
});

describe("merge policy (pure)", () => {
  test("acceptance pass still beats fail, whatever the suites say", () => {
    expect(chooseMerge({ old: true, new: false }, null, rng(1), { old: true, new: true })).toEqual({ merged: "old", reason: "pass_beats_fail" });
  });

  test("both fail acceptance: the one suite+scope-ok side, the judge between two, nothing when neither", () => {
    const fail = { old: false, new: false };
    expect(chooseMerge(fail, null, rng(1), { old: false, new: true })).toEqual({ merged: "new", reason: "suite_scope" });
    expect(chooseMerge(fail, "new", rng(1), { old: true, new: false })).toEqual({ merged: "old", reason: "suite_scope" });
    expect(chooseMerge(fail, "old", rng(1), { old: true, new: true })).toEqual({ merged: "old", reason: "suite_scope_judge" });
    expect(chooseMerge(fail, null, rng(1), { old: false, new: false })).toEqual({ merged: null, reason: "both_failed" });
    const tie = chooseMerge(fail, null, rng(5), { old: true, new: true });
    expect(tie.reason).toBe("suite_scope_random_tie");
    expect(chooseMerge(fail, null, rng(5), { old: true, new: true })).toEqual(tie);
    // Without eligibility (the registered policy) a both-fail pair merges nothing.
    expect(chooseMerge(fail, "old", rng(1))).toEqual({ merged: null, reason: "both_failed" });
  });

  test("secondary outcome", () => {
    expect(secondaryOutcome({ old: true, new: true }, "new")).toBe("new");
    expect(secondaryOutcome({ old: true, new: true }, null)).toBe("tie");
    expect(secondaryOutcome({ old: true, new: false }, null)).toBe("old");
    expect(secondaryOutcome({ old: false, new: true }, "old")).toBe("new");
    expect(secondaryOutcome({ old: false, new: false }, null)).toBe("none");
    expect(secondaryLine([{ secondary: "new" }, { secondary: "new" }, { secondary: "none" }] as ForwardPair[])).toBe(
      "forward: secondary outcome (exploratory, not H1): new 2, none 1",
    );
  });

  test("args: --remerge needs no pair, --parallel is capped at 4", () => {
    expect(parseForwardArgs(["--remerge", "--backlog", "b.md"])).toMatchObject({ remerge: true, old: undefined, parallel: 4 });
    expect(parseForwardArgs(["--backlog", "b.md", "--pair", "A,B"]).remerge).toBe(false);
    expect(() => parseForwardArgs(["--backlog", "b.md"])).toThrow(UsageError);
    expect(parseForwardArgs(["--backlog", "b.md", "--pair", "A,B", "--parallel", "4"]).parallel).toBe(4);
    expect(() => parseForwardArgs(["--backlog", "b.md", "--pair", "A,B", "--parallel", "5"])).toThrow(UsageError);
  });
});

describe("forward run with stub sides, amendment 8 on", () => {
  test("both-fail pairs merge on suite and scope; H1 fields are the same as under the registered policy", async () => {
    const outcomes: Record<string, [Outcome, Outcome]> = {
      T1: ["broken", "suite"], // only new passes its suite: new merged
      T2: ["broken", "broken"], // both fail everything: nothing merged
      T3: ["suite", "suite"], // both suite+scope ok: the judge picks
      T4: ["suite", "scope"], // new is off scope: old merged
      T5: ["accept", "suite"], // acceptance pass beats fail, as before
    };
    const script = (t: string, s: "old" | "new") => outcomes[t]![s === "old" ? 0 : 1];
    const w = makeWorld(5);
    const ref = makeWorld(5);
    try {
      const j = judge("Y");
      const res = await runForward(opts(w, scripted(script), j.llm));
      const by = Object.fromEntries(res.completed.map((p) => [p.task_id, p]));

      expect(by.T1).toMatchObject({
        pass_old: false, pass_new: false, suite_pass_old: false, suite_pass_new: true, scope_ok_old: true, scope_ok_new: true,
        merged: "new", merged_reason: "suite_scope", secondary: "new",
      });
      expect(by.T2).toMatchObject({ pass_old: false, pass_new: false, suite_pass_old: false, suite_pass_new: false, merged: null, merged_reason: "both_failed", secondary: "none" });
      const t3 = by.T3!;
      expect(t3).toMatchObject({ pass_old: false, pass_new: false, merged_reason: "suite_scope_judge" });
      expect(t3.merged).toBe(t3.blind_labels.Y!); // the judge said Y; the merge follows the label back to its side
      expect(t3.secondary).toBe(t3.merged);
      expect(by.T4).toMatchObject({ scope_ok_old: true, scope_ok_new: false, merged: "old", merged_reason: "suite_scope", secondary: "old" });
      // The judge prefers Y here, yet acceptance decides the merge; the secondary outcome records the judge's preference.
      expect(by.T5).toMatchObject({ pass_old: true, pass_new: false, merged: "old", merged_reason: "pass_beats_fail", secondary: by.T5!.blind_labels.Y });

      // T3 and T5 have two suite+scope-ok sides, so the judge ran there and nowhere else, still blind.
      expect(j.inputs).toHaveLength(2);
      for (const input of j.inputs) {
        const text = input.map((m) => m.content).join("\n");
        expect(text).not.toContain(OLD);
        expect(text).not.toContain(NEW);
      }
      expect(mergeSubjects(w.repo)).toHaveLength(4);

      // The recorded rows round-trip through the store.
      const store = new ForwardStore(join(w.root, "state.db"));
      const stored = Object.fromEntries(store.pairs().map((p) => [p.task_id, p]));
      store.close();
      expect(stored.T1).toEqual(by.T1!);

      // Same sides under the registered policy: identical pass_old/pass_new, and no both-fail merges.
      const plain = await runForward(opts(ref, scripted(script), judge("Y").llm, { buildMerge: false }));
      const pby = Object.fromEntries(plain.completed.map((p) => [p.task_id, p]));
      for (const id of Object.keys(outcomes)) {
        expect([pby[id]!.pass_old, pby[id]!.pass_new]).toEqual([by[id]!.pass_old, by[id]!.pass_new]);
      }
      expect(plain.stop).toEqual(res.stop);
      expect(pby.T1).toMatchObject({ merged: null, merged_reason: "both_failed", secondary: null, suite_pass_new: true });
    } finally {
      rmSync(w.root, { recursive: true, force: true });
      rmSync(ref.root, { recursive: true, force: true });
    }
  }, 240_000);
});

describe("--remerge", () => {
  test("revisits pairs recorded with nothing merged and applies the policy; H1 fields are untouched", async () => {
    const outcomes: Record<string, [Outcome, Outcome]> = {
      T1: ["broken", "suite"],
      T2: ["broken", "broken"],
      T3: ["accept", "accept"],
    };
    const w = makeWorld(3);
    try {
      // Recorded before amendment 8: both-fail pairs merged nothing.
      await runForward(opts(w, scripted((t, s) => outcomes[t]![s === "old" ? 0 : 1]), judge("X").llm, { buildMerge: false }));
      const db = join(w.root, "state.db");
      const before = new ForwardStore(db);
      const recorded = before.pairs();
      before.close();
      expect(recorded.filter((p) => p.merged === null).map((p) => p.task_id).sort()).toEqual(["T1", "T2"]);
      const mergesBefore = mergeSubjects(w.repo).length;

      const j = judge("X");
      const res = await remergeForward({ repo: w.repo, backlog: w.backlog, llm: j.llm, db, testCmd: "sh suite.sh", parallel: 2 });
      expect(res.skipped).toEqual([]);
      expect(res.revisited.map((p) => p.task_id).sort()).toEqual(["T1", "T2"]);
      expect(j.inputs).toHaveLength(0); // never more than one eligible side here

      const after = new ForwardStore(db);
      const pairs = after.pairs();
      after.close();
      const by = Object.fromEntries(pairs.map((p) => [p.task_id, p]));
      expect(by.T1).toMatchObject({ pass_old: false, pass_new: false, suite_pass_old: false, suite_pass_new: true, merged: "new", merged_reason: "suite_scope", secondary: "new" });
      expect(by.T2).toMatchObject({ merged: null, merged_reason: "both_failed", secondary: "none" });
      // Already-merged pairs are left alone, and the recorded order and H1 fields hold.
      expect(by.T3).toEqual(recorded.find((p) => p.task_id === "T3")!);
      expect(pairs.map((p) => p.task_id)).toEqual(recorded.map((p) => p.task_id));
      for (const p of recorded) expect([by[p.task_id]!.pass_old, by[p.task_id]!.pass_new, by[p.task_id]!.seed]).toEqual([p.pass_old, p.pass_new, p.seed]);

      const merges = mergeSubjects(w.repo);
      expect(merges).toHaveLength(mergesBefore + 1);
      expect(merges[0]).toBe(`T1: merge forward winner (${NEW})`);

      // A second remerge only revisits what is still unmerged.
      const again = await remergeForward({ repo: w.repo, backlog: w.backlog, llm: j.llm, db, testCmd: "sh suite.sh" });
      expect(again.revisited.map((p) => p.task_id)).toEqual(["T2"]);
    } finally {
      rmSync(w.root, { recursive: true, force: true });
    }
  }, 240_000);

  test("pairs whose task left the backlog are skipped", async () => {
    const w = makeWorld(1);
    try {
      await runForward(opts(w, scripted(() => "suite"), judge("X").llm, { buildMerge: false }));
      const res = await remergeForward({ repo: w.repo, backlog: "", llm: judge("X").llm, db: join(w.root, "state.db"), testCmd: "sh suite.sh" });
      expect(res).toEqual({ revisited: [], skipped: ["T1"] });
    } finally {
      rmSync(w.root, { recursive: true, force: true });
    }
  }, 120_000);
});

test("a database from before amendment 8 gains the new columns, read back as null", () => {
  const root = mkdtempSync(join(tmpdir(), "roster-forward-db-"));
  try {
    const path = join(root, "old.db");
    const db = new Database(path, { create: true });
    db.exec(`CREATE TABLE forward_pairs (
      task_id TEXT PRIMARY KEY, setup_old TEXT NOT NULL, setup_new TEXT NOT NULL, pass_old INTEGER NOT NULL, pass_new INTEGER NOT NULL,
      cost_old REAL, cost_new REAL, merged TEXT, blind_labels TEXT NOT NULL, seed INTEGER NOT NULL, seq INTEGER NOT NULL)`);
    db.query("INSERT INTO forward_pairs VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("F01", OLD, NEW, 0, 0, null, null, null, '{"X":"old","Y":"new"}', 9, 0);
    db.close();
    const store = new ForwardStore(path);
    expect(store.pairs()[0]).toMatchObject({ task_id: "F01", merged: null, suite_pass_old: null, scope_ok_new: null, merged_reason: null, secondary: null });
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
