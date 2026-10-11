import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { hiddenTests, hiddenTestsForCommits } from "../src/grade/hidden.ts";
import { git } from "./fixtures/make-fixture.ts";

const root = mkdtempSync(join(tmpdir(), "roster-hidden-helpers-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const write = (dir: string, path: string, body: string) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), body);
};

// The session's own files. The add is buggy; the session's second commit fixes it.
const ADD_BUGGY = "export const add = (a: number, b: number): number => a - b;\n";
const ADD_FIXED = "export const add = (a: number, b: number): number => a + b;\n";
const MAKE = "export const pair = (): [number, number] => [2, 3];\n";
const TEST = [
  'import { expect, test } from "bun:test";',
  'import { add } from "../src/add.ts";',
  'import { pair } from "./fixtures/make.ts";',
  "",
  'test("adds the fixture pair", () => {',
  "  const [a, b] = pair();",
  "  expect(add(a, b)).toBe(5);",
  "});",
  "",
].join("\n");

/**
 * base (src/add.ts, buggy) → c1 (adds tests/fixtures/make.ts and tests/add.test.ts) → c2 (fixes src/add.ts).
 * The session's commits are c1 and c2, so the test and its fixture come from c1.
 */
function sessionRepo(name: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  let minute = 0;
  const commit = (message: string) => {
    const at = new Date(Date.UTC(2026, 9, 1, 0, minute++)).toISOString();
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", message], { env: { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });
    return git(dir, ["rev-parse", "HEAD"]);
  };
  write(dir, "src/add.ts", ADD_BUGGY);
  commit("base");
  write(dir, "tests/fixtures/make.ts", MAKE);
  write(dir, "tests/add.test.ts", TEST);
  const c1 = commit("c1 add test and fixture");
  write(dir, "src/add.ts", ADD_FIXED);
  const c2 = commit("c2 fix add");
  return { dir, c1, c2 };
}

/** Writes a grading copy the way the grader does: base + the agent's patch, then the hidden files. */
function gradingCopy(hidden: { path: string; content: string }[], patch: Record<string, string>) {
  const dir = mkdtempSync(join(root, "grade-"));
  write(dir, "src/add.ts", ADD_BUGGY);
  for (const [path, body] of Object.entries(patch)) write(dir, path, body);
  for (const h of hidden) write(dir, h.path, h.content);
  return dir;
}

describe("hidden tests come with their support files", () => {
  test("a session that added tests/x.test.ts importing tests/fixtures/make.ts gets both files", () => {
    const { dir, c1, c2 } = sessionRepo("both");
    const got = hiddenTestsForCommits(dir, [c1, c2]);
    expect(got.map((h) => h.path).sort()).toEqual(["tests/add.test.ts", "tests/fixtures/make.ts"]);
    expect(got.find((h) => h.path === "tests/fixtures/make.ts")!.content).toBe(MAKE);
  });

  test("only the test case is a test; the fixture is marked as support", () => {
    const { dir, c1, c2 } = sessionRepo("marked");
    const got = hiddenTestsForCommits(dir, [c1, c2]);
    expect(got.find((h) => h.path === "tests/add.test.ts")!.support).toBeUndefined();
    expect(got.find((h) => h.path === "tests/fixtures/make.ts")!.support).toBe(true);
  });

  test("hiddenTests (single commit) carries the same support files", () => {
    const { dir, c1 } = sessionRepo("single");
    expect(hiddenTests(dir, c1).map((h) => h.path).sort()).toEqual(["tests/add.test.ts", "tests/fixtures/make.ts"]);
  });

  test("the incumbent's correct patch passes once the fixture is present", () => {
    const { dir, c1, c2 } = sessionRepo("replay");
    const hidden = hiddenTestsForCommits(dir, [c1, c2]);
    const copy = gradingCopy(hidden, { "src/add.ts": ADD_FIXED });
    const r = Bun.spawnSync(["bun", "test", "tests/add.test.ts"], { cwd: copy });
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toString() + r.stdout.toString()).toMatch(/1 pass/);
  });

  test("without the fixture the same correct patch cannot even import the test", () => {
    const { dir, c1, c2 } = sessionRepo("missing");
    const hidden = hiddenTestsForCommits(dir, [c1, c2]).filter((h) => h.path !== "tests/fixtures/make.ts");
    const copy = gradingCopy(hidden, { "src/add.ts": ADD_FIXED });
    expect(Bun.spawnSync(["bun", "test", "tests/add.test.ts"], { cwd: copy }).exitCode).not.toBe(0);
  });

  test("a helper the session did not touch is not pulled in", () => {
    const { dir, c1, c2 } = sessionRepo("untouched");
    write(dir, "tests/other-helper.ts", "export const x = 1;\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "unrelated helper"]);
    const got = hiddenTestsForCommits(dir, [c1, c2]).map((h) => h.path);
    expect(got).not.toContain("tests/other-helper.ts");
  });

  test("a session that added only a helper has no hidden tests (judge-only)", () => {
    const dir = join(root, "helper-only");
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-q", "-b", "main"]);
    write(dir, "README.md", "base\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "base"]);
    write(dir, "tests/fixtures/make.ts", MAKE);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "helper only"]);
    const sha = git(dir, ["rev-parse", "HEAD"]);
    expect(hiddenTestsForCommits(dir, [sha])).toEqual([]);
  });

  test("a support file deleted after the session's version is still the session's version", () => {
    const { dir, c1, c2 } = sessionRepo("deleted");
    git(dir, ["rm", "-q", "tests/fixtures/make.ts"]);
    git(dir, ["commit", "-q", "-m", "drop fixture"]);
    const got = hiddenTestsForCommits(dir, [c1, c2]).map((h) => h.path).sort();
    expect(got).toEqual(["tests/add.test.ts", "tests/fixtures/make.ts"]);
  });

  test("a support file the session deleted before its last commit is dropped", () => {
    const dir = join(root, "deleted-in-session");
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-q", "-b", "main"]);
    write(dir, "README.md", "base\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "base"]);
    write(dir, "tests/add.test.ts", TEST);
    write(dir, "tests/fixtures/make.ts", MAKE);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "c1"]);
    const c1 = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["rm", "-q", "tests/fixtures/make.ts"]);
    git(dir, ["commit", "-q", "-m", "c2 drop fixture"]);
    const c2 = git(dir, ["rev-parse", "HEAD"]);
    expect(hiddenTestsForCommits(dir, [c1, c2]).map((h) => h.path)).toEqual(["tests/add.test.ts"]);
  });
});
