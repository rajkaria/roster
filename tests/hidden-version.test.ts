import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hiddenTests, hiddenTestsForCommits } from "../src/grade/hidden.ts";
import { git } from "./fixtures/make-fixture.ts";

const root = mkdtempSync(join(tmpdir(), "roster-hidden-version-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const write = (dir: string, path: string, body: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), body);
};
const commit = (dir: string, message: string) => {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
};
const init = (name: string) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  write(dir, "README.md", "base\n");
  commit(dir, "base");
  return dir;
};

describe("hidden test version", () => {
  test("a later unrelated edit does not change the session's version", () => {
    const dir = init("linear");
    write(dir, "tests/x.test.ts", "// session version\n");
    const s = commit(dir, "session adds test");
    for (let i = 0; i < 7; i++) {
      write(dir, "other.txt", `${i}\n`);
      commit(dir, `filler ${i}`);
    }
    write(dir, "tests/x.test.ts", "// later feature version\n");
    commit(dir, "later task edits test");
    expect(hiddenTests(dir, s)[0]!.content).toBe("// session version\n");
    expect(hiddenTestsForCommits(dir, [s])[0]!.content).toBe("// session version\n");
  });

  test("a session branch is read at the merge commit that brought it in", () => {
    const dir = init("merge");
    git(dir, ["checkout", "-q", "-b", "feature"]);
    write(dir, "tests/x.test.ts", "// feature version\n");
    const s = commit(dir, "session adds test");
    git(dir, ["checkout", "-q", "main"]);
    write(dir, "other.txt", "1\n");
    commit(dir, "main moves");
    git(dir, ["merge", "-q", "--no-ff", "-m", "merge feature", "feature"]);
    write(dir, "tests/x.test.ts", "// later feature version\n");
    commit(dir, "later task edits test");
    expect(hiddenTests(dir, s)[0]!.content).toBe("// feature version\n");
    expect(hiddenTestsForCommits(dir, [s])[0]!.content).toBe("// feature version\n");
  });
});
