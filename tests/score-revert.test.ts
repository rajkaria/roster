import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { reverted } from "../src/score/revert.ts";
import { rework } from "../src/score/rework.ts";
import { git, makeFixture, type FixtureTruth, type Scenario } from "./fixtures/make-fixture.ts";

// Building a fixture spawns git a few hundred times.
setDefaultTimeout(30_000);

const root = mkdtempSync(join(tmpdir(), "roster-score-revert-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const fixtures = new Map<Scenario, { dir: string; truth: FixtureTruth }>();
function fixture(scenario: Scenario) {
  let f = fixtures.get(scenario);
  if (!f) {
    const dir = join(root, scenario);
    f = { dir, truth: makeFixture(dir, scenario) };
    fixtures.set(scenario, f);
  }
  return f;
}

/** The sha of the commit with this subject, which the fixture generator recorded as ground truth. */
function sha(truth: FixtureTruth, subject: string): string {
  const c = truth.commits.find((x) => x.subject === subject);
  if (!c) throw new Error(`no fixture commit "${subject}"`);
  return c.sha;
}

// Small repos built in-test for shapes the fixture generator does not produce: agent rework of
// agent lines, and merges. Each commit is a line-by-line rewrite of a generated module.
let counter = 0;
function newRepo(): string {
  const dir = join(root, `repo-${counter++}`);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  return dir;
}
function writeLines(dir: string, rel: string, name: string, n: number, edit: Record<number, string> = {}) {
  const lines = Array.from({ length: n }, (_, i) => edit[i] ?? `export const ${name}_${i} = ${i};`);
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), lines.join("\n") + "\n");
}
function commit(dir: string, message: string): string {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "--no-gpg-sign", "-F", "-"], { input: message });
  return git(dir, ["rev-parse", "HEAD"]);
}
const AGENT = (id: string, subject: string) => `${subject}\n\nEntire-Checkpoint: ${id}\n`;

describe("basic fixture", () => {
  test("a commit reverted by a later 'This reverts commit' is reverted, even outside the window", () => {
    const { dir, truth } = fixture("basic");
    const gamma = sha(truth, "add gamma");
    expect(reverted(dir, gamma)).toBe(true);
    expect(reverted(dir, gamma, 1)).toBe(true);
  });

  test("a commit that a human only partly rewrote is not reverted, and its rework share is the rewritten part", () => {
    const { dir, truth } = fixture("basic");
    const alpha = sha(truth, "add alpha");
    // 10 of alpha's 30 lines rewritten by a human commit: 33%, under the 50% threshold.
    expect(reverted(dir, alpha)).toBe(false);
    const r = rework(dir, alpha);
    expect(r.human).toBeCloseTo(10 / 30, 10);
    expect(r.agent).toBe(0);
  });

  test("untouched commits have no reverts and no rework", () => {
    const { dir, truth } = fixture("basic");
    for (const subject of ["add beta", "add delta"]) {
      expect(reverted(dir, sha(truth, subject))).toBe(false);
      expect(rework(dir, sha(truth, subject))).toEqual({ human: 0, agent: 0 });
    }
  });

  test("the revert commit itself is human work, so reverting a commit counts as full human rework", () => {
    const { dir, truth } = fixture("basic");
    expect(rework(dir, sha(truth, "add gamma"))).toEqual({ human: 1, agent: 0 });
  });
});

describe("revert fixture", () => {
  test("a commit with at least half its added lines deleted in the window is reverted", () => {
    const { dir, truth } = fixture("revert");
    const beta = sha(truth, "add beta");
    // The human trim deletes 12 of beta's 20 lines: 60%, no revert message.
    expect(reverted(dir, beta)).toBe(true);
    const r = rework(dir, beta);
    expect(r.human).toBeCloseTo(12 / 20, 10);
    expect(r.agent).toBe(0);
  });

  test("the deletion must land inside the window", () => {
    const { dir, truth } = fixture("revert");
    const beta = sha(truth, "add beta");
    // Later first-parent commits: gamma, revert, delta, rework alpha, trim beta.
    expect(reverted(dir, beta, 4)).toBe(false);
    expect(reverted(dir, beta, 5)).toBe(true);
  });

  test("alpha is partly rewritten by a human and stays unreverted", () => {
    const { dir, truth } = fixture("revert");
    expect(reverted(dir, sha(truth, "add alpha"))).toBe(false);
  });
});

describe("agent and human rework", () => {
  test("rework shares split by checkpoint trailer, and 40% modified stays under the revert threshold", () => {
    const dir = newRepo();
    writeLines(dir, "README.md", "readme", 1);
    commit(dir, "init\n");
    writeLines(dir, "src/g.ts", "g", 10);
    const a = commit(dir, AGENT("aaaaaaaaaaaa", "agent: add g"));
    // Agent rewrites lines 0-2; a human rewrites line 3.
    writeLines(dir, "src/g.ts", "g", 10, { 0: "export const g_0 = 90;", 1: "export const g_1 = 91;", 2: "export const g_2 = 92;" });
    commit(dir, AGENT("bbbbbbbbbbbb", "agent: tweak g"));
    writeLines(dir, "src/g.ts", "g", 10, {
      0: "export const g_0 = 90;",
      1: "export const g_1 = 91;",
      2: "export const g_2 = 92;",
      3: "export const g_3 = 93;",
    });
    commit(dir, "human: fix g\n");

    const r = rework(dir, a);
    expect(r.agent).toBeCloseTo(0.3, 10);
    expect(r.human).toBeCloseTo(0.1, 10);
    expect(reverted(dir, a)).toBe(false);
  });

  test("a change where most lines are later deleted is reverted, without any revert message", () => {
    const dir = newRepo();
    writeLines(dir, "README.md", "readme", 1);
    commit(dir, "init\n");
    writeLines(dir, "src/h.ts", "h", 4);
    const a = commit(dir, AGENT("cccccccccccc", "agent: add h"));
    writeLines(dir, "src/h.ts", "h", 4, { 0: "x", 1: "y", 2: "z" });
    commit(dir, AGENT("dddddddddddd", "agent: rewrite h"));
    expect(reverted(dir, a)).toBe(true);
    expect(rework(dir, a)).toEqual({ human: 0, agent: 0.75 });
  });
});

describe("merge commits", () => {
  test("a merge is read against its first parent, and a later edit on the merged branch is not seen", () => {
    const dir = newRepo();
    writeLines(dir, "README.md", "readme", 1);
    commit(dir, "init\n");

    git(dir, ["checkout", "-q", "-b", "feature"]);
    writeLines(dir, "src/k.ts", "k", 8);
    const f1 = commit(dir, AGENT("eeeeeeeeeeee", "agent: add k"));
    // Lives on the feature branch only: first-parent history never reaches it.
    writeLines(dir, "src/k.ts", "k", 8, { 1: "export const k_1 = 100;" });
    commit(dir, AGENT("ffffffffffff", "agent: fix k"));

    git(dir, ["checkout", "-q", "main"]);
    writeLines(dir, "docs.md", "docs", 1);
    commit(dir, "human: docs\n");
    git(dir, ["merge", "--no-ff", "-q", "-m", "merge feature\n", "feature"]);
    const merge = git(dir, ["rev-parse", "HEAD"]);

    // A human rewrites two of the merged lines, one of them the one the feature branch changed.
    writeLines(dir, "src/k.ts", "k", 8, { 0: "export const k_0 = 50;", 1: "export const k_1 = 51;" });
    commit(dir, "human: rewrite k\n");

    expect(rework(dir, merge)).toEqual({ human: 0.25, agent: 0 });
    expect(reverted(dir, merge)).toBe(false);
    // f1 is on a side branch, so the feature-branch edit is off the first-parent walk. Only the
    // human's rewrite of the original line 0 counts.
    expect(rework(dir, f1)).toEqual({ human: 0.125, agent: 0 });
  });
});
