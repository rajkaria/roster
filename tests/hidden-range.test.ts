import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hiddenTests, hiddenTestsForCommits } from "../src/grade/hidden.ts";
import { buildReplayTasks } from "../src/replay/tasks.ts";
import type { Session } from "../src/types.ts";
import { git } from "./fixtures/make-fixture.ts";

const root = mkdtempSync(join(tmpdir(), "roster-hidden-range-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const write = (dir: string, path: string, body: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), body);
};

/**
 * base → c1 (adds src/x.ts) → c2 (adds tests/x.test.ts) → c3 (edits src/x.ts).
 * The session's commits are c1..c3; the test file was committed separately from the code.
 */
function sessionRepo(name: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  // One minute apart, so the commits order by time the way they were made.
  let minute = 0;
  const commit = (message: string) => {
    const at = new Date(Date.UTC(2026, 9, 1, 0, minute++)).toISOString();
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", message], { env: { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });
  };
  write(dir, "README.md", "base\n");
  commit("base");
  write(dir, "src/x.ts", "export const x = 1;\n");
  commit("c1 add src");
  const c1 = git(dir, ["rev-parse", "HEAD"]);
  write(dir, "tests/x.test.ts", "import { x } from '../src/x.ts';\n");
  commit("c2 add tests");
  const c2 = git(dir, ["rev-parse", "HEAD"]);
  write(dir, "src/x.ts", "export const x = 2;\n");
  commit("c3 edit src");
  const c3 = git(dir, ["rev-parse", "HEAD"]);
  return { dir, c1, c2, c3 };
}

const session = (id: string, commitSha: string, firstPrompt: string): Session => ({
  id,
  repo: "",
  checkpoint_id: id,
  harness: "claude-code",
  model: "unknown",
  rules_hash: null,
  setup_id: null,
  tokens_in: 0,
  tokens_out: 0,
  cache_read: 0,
  cache_write: 0,
  cost_usd: null,
  n_user_prompts: 1,
  first_prompt: firstPrompt,
  commit_sha: commitSha,
  started_at: "2026-10-01T00:00:00Z",
  ended_at: "2026-10-01T01:00:00Z",
  files: [],
  entire_url: null,
  source: "branch",
} as Session);

describe("hiddenTestsForCommits", () => {
  test("a test committed separately from the code is found through the session's commits", () => {
    const { dir, c1, c2, c3 } = sessionRepo("union");
    const tests = hiddenTestsForCommits(dir, [c1, c2, c3]);
    expect(tests.map((t) => t.path)).toEqual(["tests/x.test.ts"]);
    expect(tests[0]!.content).toBe("import { x } from '../src/x.ts';\n");
    // The single-commit rule, applied to the last commit alone, misses it.
    expect(hiddenTests(dir, c3)).toEqual([]);
  });

  test("the task built from the session's commits gets the test file and track 'tests'", () => {
    const { dir, c1, c2, c3 } = sessionRepo("task");
    const s = session("s-task", c1, "[roster setup=Z task=z1]\nAdd x and its test.");
    const extra = [session("s-task", c2, s.first_prompt), session("s-task", c3, s.first_prompt)];
    const [task] = buildReplayTasks(dir, [s, ...extra], []);
    expect(task!.originalSha).toBe(c3);
    expect(task!.parentSha).toBe(git(dir, ["rev-parse", `${c1}^1`]));
    expect(task!.hiddenTests.map((h) => h.path)).toEqual(["tests/x.test.ts"]);
    expect(task!.track).toBe("tests");
  });

  test("a test file deleted later is still the session's version (no maturity rule)", () => {
    const { dir, c1, c2, c3 } = sessionRepo("deleted");
    git(dir, ["rm", "-q", "tests/x.test.ts"]);
    git(dir, ["commit", "-q", "-m", "drop test"], {
      env: { GIT_AUTHOR_DATE: "2026-10-01T01:00:00Z", GIT_COMMITTER_DATE: "2026-10-01T01:00:00Z" },
    });
    expect(hiddenTestsForCommits(dir, [c1, c2, c3]).map((t) => t.path)).toEqual(["tests/x.test.ts"]);
  });

  test("no commits gives no tests", () => {
    const { dir } = sessionRepo("empty");
    expect(hiddenTestsForCommits(dir, [])).toEqual([]);
  });
});
