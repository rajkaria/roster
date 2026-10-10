import { test, expect } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, basename } from "node:path";
import { plant } from "../../../scripts/planted/plant";

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-c", "color.ui=false", ...args], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(repo: string, message: string): void {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", message]);
}

function commitByMessage(repo: string, subject: string): string | undefined {
  const output = execFileSync("git", ["-c", "color.ui=false", "log", "--format=%H%x00%s"], {
    cwd: repo,
    encoding: "utf8",
  });

  for (const line of output.trim().split("\n")) {
    const idx = line.indexOf("\0");
    if (idx === -1) continue;
    const hash = line.slice(0, idx);
    const msg = line.slice(idx + 1);
    if (msg === subject) return hash;
  }

  return undefined;
}

function isAncestor(repo: string, ancestor: string, descendant: string): boolean {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: repo,
    encoding: "utf8",
  });
  return result.status === 0;
}

test("plants bugs and fixes, skips no-editable commits, leaves source untouched", async () => {
  const base = mkdtempSync(join(tmpdir(), "planted-f10-"));
  const source = join(base, "source");
  const out = join(base, "copy");
  const keyPath = join(base, "answer-key.json");
  mkdirSync(source);

  git(source, ["init", "-b", "main"]);
  git(source, ["config", "user.email", "test@example.com"]);
  git(source, ["config", "user.name", "Test"]);

  writeFileSync(join(source, "README.md"), "# repo\n");
  commit(source, "initial commit");

  writeFileSync(
    join(source, "a.txt"),
    "const a = 1;\nif (a < 2) {\n  console.log(\"ok\");\n}\n",
  );
  commit(source, "add comparison A");
  const shaA = git(source, ["rev-parse", "HEAD"]);

  writeFileSync(join(source, "notes.txt"), "just some notes\n");
  commit(source, "add skip note");
  const shaSkip = git(source, ["rev-parse", "HEAD"]);

  writeFileSync(
    join(source, "c.txt"),
    "function test(x) {\n  return x >= 0;\n}\n",
  );
  commit(source, "add comparison C");
  const shaC = git(source, ["rev-parse", "HEAD"]);

  const sourceHeadBefore = git(source, ["rev-parse", "HEAD"]);
  const sourceStatusBefore = git(source, ["status", "--porcelain"]);
  expect(sourceStatusBefore).toBe("");

  const result = await plant({
    sourceRepo: source,
    outDir: out,
    keyPath,
    commits: [shaA, shaSkip, shaC],
    seed: 123,
  });

  const sourceHeadAfter = git(source, ["rev-parse", "HEAD"]);
  const sourceStatusAfter = git(source, ["status", "--porcelain"]);
  expect(sourceHeadAfter).toBe(sourceHeadBefore);
  expect(sourceStatusAfter).toBe(sourceStatusBefore);

  expect(existsSync(join(out, ".git"))).toBe(true);

  // Key is written outside the copy and not inside it.
  expect(existsSync(keyPath)).toBe(true);
  expect(relative(out, keyPath)).toMatch(/^\.\./);
  expect(existsSync(join(out, basename(keyPath)))).toBe(false);

  const keyJson = JSON.parse(readFileSync(keyPath, "utf8"));
  expect(JSON.stringify(keyJson)).toContain(shaSkip);

  expect(result.planted.map((p) => p.file)).toEqual(["a.txt", "c.txt"]);

  const aEntry = result.planted.find((p) => p.file === "a.txt");
  const cEntry = result.planted.find((p) => p.file === "c.txt");
  if (!aEntry || !cEntry) throw new Error("expected both editable commits to be planted");

  const copyCommitA = commitByMessage(out, "add comparison A");
  if (!copyCommitA) throw new Error("copy commit A not found");
  const bugDiffA = git(out, ["show", "--format=", "--unified=0", copyCommitA, "--", "a.txt"]);
  expect(bugDiffA).not.toContain("+if (a < 2) {");
  expect(bugDiffA).toMatch(/^\+if \(a (?:>|>=|<=|==|!=) 2\) \{\}$/m);

  expect(aEntry.line).toBeGreaterThan(0);
  expect(git(out, ["cat-file", "-t", aEntry.fixCommit])).toBe("commit");
  expect(git(out, ["show", "-s", "--format=%s", aEntry.fixCommit])).toMatch(/^fix:/);

  const fixDiffA = git(out, ["show", "--format=", "--unified=0", aEntry.fixCommit, "--", "a.txt"]);
  expect(fixDiffA).toContain("+if (a < 2) {");
  expect(fixDiffA).toMatch(/^-if \(a (?:>|>=|<=|==|!=) 2\) \{\}$/m);
  expect(isAncestor(out, copyCommitA, aEntry.fixCommit)).toBe(true);

  const copyCommitC = commitByMessage(out, "add comparison C");
  if (!copyCommitC) throw new Error("copy commit C not found");
  const bugDiffC = git(out, ["show", "--format=", "--unified=0", copyCommitC, "--", "c.txt"]);
  expect(bugDiffC).not.toContain("+  return x >= 0;");
  expect(bugDiffC).toMatch(/^\+  return x (?:<|<=|>|==|!=) 0;$/m);

  expect(cEntry.line).toBeGreaterThan(0);
  expect(git(out, ["cat-file", "-t", cEntry.fixCommit])).toBe("commit");
  expect(git(out, ["show", "-s", "--format=%s", cEntry.fixCommit])).toMatch(/^fix:/);

  const fixDiffC = git(out, ["show", "--format=", "--unified=0", cEntry.fixCommit, "--", "c.txt"]);
  expect(fixDiffC).toContain("+  return x >= 0;");
  expect(fixDiffC).toMatch(/^-  return x (?:<|<=|>|==|!=) 0;$/m);
  expect(isAncestor(out, copyCommitC, cEntry.fixCommit)).toBe(true);

  const copySkip = commitByMessage(out, "add skip note");
  if (!copySkip) throw new Error("copy skip commit not found");
  const skipDiff = git(out, ["show", "--format=", "--unified=0", copySkip, "--", "notes.txt"]);
  expect(skipDiff).toContain("+just some notes");
});

test("same seed chooses the same editable line", async () => {
  const base = mkdtempSync(join(tmpdir(), "planted-f10-seed-"));
  const source = join(base, "source");
  mkdirSync(source);

  git(source, ["init", "-b", "main"]);
  git(source, ["config", "user.email", "test@example.com"]);
  git(source, ["config", "user.name", "Test"]);

  writeFileSync(join(source, "README.md"), "# repo\n");
  commit(source, "initial");

  writeFileSync(
    join(source, "multi.txt"),
    "if (a < b) { return 1; }\nif (c > d) { return 2; }\n",
  );
  commit(source, "add multi");
  const sha = git(source, ["rev-parse", "HEAD"]);

  const result1 = await plant({
    sourceRepo: source,
    outDir: join(base, "copy1"),
    keyPath: join(base, "key1.json"),
    commits: [sha],
    seed: 42,
  });

  const result2 = await plant({
    sourceRepo: source,
    outDir: join(base, "copy2"),
    keyPath: join(base, "key2.json"),
    commits: [sha],
    seed: 42,
  });

  const e1 = result1.planted.find((p) => p.file === "multi.txt");
  const e2 = result2.planted.find((p) => p.file === "multi.txt");
  if (!e1 || !e2) throw new Error("expected multi.txt to be planted in both copies");

  expect(e1.line).toBe(e2.line);
});
