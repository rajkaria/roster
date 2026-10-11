import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

import { plant, scanOperators, type PlantedBug, type PlantResult } from "../scripts/planted/plant.ts";

// Every plant clones a repo and replays history, so each case is a handful of git processes.
setDefaultTimeout(60_000);

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(name: string): string {
  const d = mkdtempSync(join(tmpdir(), `roster-planted-${name}-`));
  dirs.push(d);
  return d;
}

function run(cwd: string, args: string[]) {
  return Bun.spawnSync(["git", "-c", "color.ui=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
}

function git(cwd: string, args: string[]): string {
  const r = run(cwd, args);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

function commit(cwd: string, message: string): string {
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "--no-gpg-sign", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return run(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]).exitCode === 0;
}

/** A source repo with a deterministic identity, one commit per step, ids oldest first. */
function sourceRepo(name: string, steps: { file: string; content: string; message: string }[]): { dir: string; shas: string[] } {
  const dir = join(tmp(name), "source");
  mkdirSync(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "planted@example.com"]);
  git(dir, ["config", "user.name", "Planted Test"]);
  const shas: string[] = [];
  for (const s of steps) {
    writeFileSync(join(dir, s.file), s.content);
    shas.push(commit(dir, s.message));
  }
  return { dir, shas };
}

function at(list: string[], i: number): string {
  const v = list[i];
  if (v === undefined) throw new Error(`no element ${i}`);
  return v;
}

const byFile = (result: PlantResult, file: string): PlantedBug => {
  const e = result.planted.find((p) => p.file === file);
  if (!e) throw new Error(`no planted entry for ${file}`);
  return e;
};

const lines = (text: string) => text.split("\n");
/** Content of the added lines in a `git show --unified=0` diff, headers excluded. */
const addedLines = (diff: string) =>
  diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1));
const OPERATORS = ["<", ">", "<=", ">=", "==", "!="];

const A_FILE = 'const a = 1;\nif (a < 2) {\n  console.log("ok");\n}\n';
const C_FILE = "function test(x) {\n  return x >= 0;\n}\n";

describe("plant", () => {
  test("flips one operator in each chosen commit, adds a fix, and leaves the source alone", async () => {
    const base = tmp("basic");
    const { dir: src, shas } = sourceRepo("basic", [
      { file: "README.md", content: "# repo\n", message: "initial commit" },
      { file: "a.txt", content: A_FILE, message: "add comparison A" },
      { file: "notes.txt", content: "just some notes\n", message: "add skip note" },
      { file: "c.txt", content: C_FILE, message: "add comparison C" },
    ]);
    const [shaA, shaSkip, shaC] = [at(shas, 1), at(shas, 2), at(shas, 3)];
    const sourceTip = git(src, ["rev-parse", "HEAD"]);
    const sourceTree = git(src, ["rev-parse", "HEAD^{tree}"]);

    const copy = join(base, "out", "copy");
    const keyPath = join(base, "answer-key.json");
    const result = await plant({ sourceRepo: src, outDir: copy, keyPath, commits: [shaA, shaSkip, shaC], seed: 7 });

    // History order, not call order; the notes commit added no comparison line.
    expect(result.planted.map((p) => p.file)).toEqual(["a.txt", "c.txt"]);
    expect(result.planted.map((p) => p.sourceCommit)).toEqual([shaA, shaC]);
    expect(result.skipped.map((s) => s.sourceCommit)).toEqual([shaSkip]);

    const cases = [
      { entry: byFile(result, "a.txt"), file: "a.txt", original: "if (a < 2) {", subject: "add comparison A" },
      { entry: byFile(result, "c.txt"), file: "c.txt", original: "  return x >= 0;", subject: "add comparison C" },
    ];
    expect(cases[0]?.entry.line).toBe(2);
    expect(cases[0]?.entry.originalOperator).toBe("<");
    expect(cases[1]?.entry.line).toBe(2);
    expect(cases[1]?.entry.originalOperator).toBe(">=");

    for (const { entry, file, original, subject } of cases) {
      expect(OPERATORS).toContain(entry.operator);
      expect(entry.operator).not.toBe(entry.originalOperator);
      const flipped = original.replace(entry.originalOperator, entry.operator);

      // The bug commit keeps the source subject and shows exactly the flipped line.
      expect(git(copy, ["cat-file", "-t", entry.commit])).toBe("commit");
      expect(git(copy, ["show", "-s", "--format=%s", entry.commit])).toBe(subject);
      const bugDiff = git(copy, ["show", "--format=", "--unified=0", entry.commit, "--", file]);
      expect(bugDiff).not.toContain(`+${original}`);
      expect(addedLines(bugDiff)).toContain(flipped);

      // The flip is one line of that file, and `line` points at it.
      const source = lines(git(src, ["show", `${entry.sourceCommit}:${file}`]));
      const bugged = lines(git(copy, ["show", `${entry.commit}:${file}`]));
      expect(bugged.map((l, i) => (l === source[i] ? null : l)).filter((l) => l !== null)).toEqual([flipped]);
      expect(bugged[entry.line - 1]).toBe(flipped);
      expect(source[entry.line - 1]).toBe(original);

      // The fix commit is a later descendant that restores the source file exactly.
      expect(git(copy, ["show", "-s", "--format=%s", entry.fixCommit])).toMatch(/^fix:/);
      expect(isAncestor(copy, entry.commit, entry.fixCommit)).toBe(true);
      expect(git(copy, ["show", `${entry.fixCommit}:${file}`])).toBe(source.join("\n"));
      const fixDiff = git(copy, ["show", "--format=", "--unified=0", entry.fixCommit, "--", file]);
      expect(addedLines(fixDiff)).toContain(original);
      expect(fixDiff).toContain(`-${flipped}`);
    }

    // One extra commit per planted bug; the tree at the tip is the source tree again.
    expect(git(copy, ["rev-list", "--count", "HEAD"])).toBe(String(shas.length + result.planted.length));
    expect(git(copy, ["rev-parse", "HEAD^{tree}"])).toBe(sourceTree);
    // History before the first planted commit keeps its ids.
    expect(git(copy, ["rev-parse", `${shaA}~1`])).toBe(at(shas, 0));
    // The copy is checked out at its new tip.
    expect(git(copy, ["status", "--porcelain"])).toBe("");
    expect(readFileSync(join(copy, "a.txt"), "utf8")).toBe(A_FILE);

    // The key is outside the copy and carries the skipped commit's source id.
    expect(relative(copy, keyPath).startsWith("..")).toBe(true);
    expect(existsSync(join(copy, basename(keyPath)))).toBe(false);
    const key = JSON.parse(readFileSync(keyPath, "utf8"));
    expect(key.seed).toBe(7);
    expect(JSON.stringify(key)).toContain(shaSkip);
    expect(key.planted).toHaveLength(2);
    expect(key.skipped).toEqual([
      { commit: expect.any(String), sourceCommit: shaSkip, reason: "added no editable comparison line" },
    ]);
    expect(key.copyHead).toBe(git(copy, ["rev-parse", "HEAD"]));

    // Source untouched: same HEAD, same clean status.
    expect(git(src, ["rev-parse", "HEAD"])).toBe(sourceTip);
    expect(git(src, ["status", "--porcelain"])).toBe("");
  });

  test("a commit that added no comparison line is skipped and changes no id", async () => {
    const base = tmp("skip");
    const { dir: src, shas } = sourceRepo("skip", [
      { file: "README.md", content: "# repo\n", message: "initial commit" },
      { file: "notes.txt", content: "just some notes\n", message: "add skip note" },
      { file: "calc.py", content: "total = 1\n", message: "add python" },
      { file: "readme2.md", content: "more\n", message: "add docs" },
    ]);
    const notes = at(shas, 1);

    const copy = join(base, "copy");
    const result = await plant({ sourceRepo: src, outDir: copy, keyPath: join(base, "key.json"), commits: [notes], seed: 1 });

    expect(result.planted).toEqual([]);
    expect(result.skipped).toEqual([
      { commit: expect.any(String), sourceCommit: notes, reason: "added no editable comparison line" },
    ]);
    // Nothing was rewritten, so every id is identical to the source.
    expect(result.skipped[0]?.commit).toBe(notes);
    expect(git(copy, ["rev-parse", "HEAD"])).toBe(git(src, ["rev-parse", "HEAD"]));
    expect(git(copy, ["rev-parse", "HEAD^{tree}"])).toBe(git(src, ["rev-parse", "HEAD^{tree}"]));
  });

  test("the seed decides the line; the same seed reproduces the same copy", async () => {
    const base = tmp("seed");
    const { dir: src, shas } = sourceRepo("seed", [
      { file: "README.md", content: "# repo\n", message: "initial commit" },
      {
        file: "multi.txt",
        content: "if (a < b) { return 1; }\nif (c > d) { return 2; }\nif (e <= f) { return 3; }\n",
        message: "add multi",
      },
    ]);
    const sha = at(shas, 1);

    const once = async (name: string, seed: number) =>
      await plant({ sourceRepo: src, outDir: join(base, name), keyPath: join(base, `${name}.json`), commits: [sha], seed });

    const first = await once("first", 42);
    const second = await once("second", 42);
    const entry = first.planted[0];
    if (!entry) throw new Error("expected a planted bug");
    expect(entry.line).toBeGreaterThanOrEqual(1);
    expect(entry.line).toBeLessThanOrEqual(3);
    expect(first.planted[0]?.line).toBe(second.planted[0]?.line);
    expect(first.planted[0]?.operator).toBe(second.planted[0]?.operator);
    expect(first.planted[0]?.commit).toBe(second.planted[0]?.commit);

    // Different seeds land on different lines, otherwise the seed is not driving anything.
    const seen = new Set<number>();
    for (let seed = 0; seed < 8; seed++) {
      const r = await once(`seed-${seed}`, seed);
      const e = r.planted[0];
      if (e) seen.add(e.line);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  test("processes commits in history order and reports duplicates and unknown ids", async () => {
    const base = tmp("order");
    const { dir: src, shas } = sourceRepo("order", [
      { file: "README.md", content: "# repo\n", message: "initial commit" },
      { file: "a.txt", content: "if (a < b) { run(); }\n", message: "add a" },
      { file: "b.txt", content: "while (i >= 0) { i--; }\n", message: "add b" },
      { file: "notes.txt", content: "notes\n", message: "add notes" },
    ]);
    const first = at(shas, 1);
    const second = at(shas, 2);
    const unknown = "cafebabecafebabecafebabecafebabecafebabe";

    const result = await plant({
      sourceRepo: src,
      outDir: join(base, "copy"),
      keyPath: join(base, "key.json"),
      commits: [second, unknown, first, second],
      seed: 3,
    });

    expect(result.planted.map((p) => p.sourceCommit)).toEqual([first, second]);
    expect(result.planted.map((p) => p.file)).toEqual(["a.txt", "b.txt"]);
    // Missing and duplicate ids are reported in the order the caller listed them.
    expect(result.skipped.map((s) => [s.sourceCommit, s.reason])).toEqual([
      [unknown, "not a commit in the source repo"],
      [second, "duplicate commit in the commits list"],
    ]);
    expect(result.skipped[0]?.commit).toBeNull();
    expect(result.skipped[1]?.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  test("edits an appended line of an existing file and keeps the line number", async () => {
    const base = tmp("append");
    const { dir: src, shas } = sourceRepo("append", [
      { file: "README.md", content: "# repo\n", message: "initial commit" },
      { file: "mod.txt", content: "const one = 1;\nconst two = 2;\n", message: "add module" },
      { file: "mod.txt", content: "const one = 1;\nconst two = 2;\nif (one <= two) { merge(); }\n", message: "add guard" },
    ]);

    const copy = join(base, "copy");
    const result = await plant({ sourceRepo: src, outDir: copy, keyPath: join(base, "key.json"), commits: [at(shas, 2)], seed: 11 });

    const entry = byFile(result, "mod.txt");
    expect(entry.line).toBe(3);
    expect(entry.originalOperator).toBe("<=");
    const bugged = lines(git(copy, ["show", `${entry.commit}:mod.txt`]));
    expect(bugged[0]).toBe("const one = 1;");
    expect(bugged[1]).toBe("const two = 2;");
    expect(bugged[2]).toBe(`if (one ${entry.operator} two) { merge(); }`);
    const bugDiff = git(copy, ["show", "--format=", "--unified=0", entry.commit, "--", "mod.txt"]);
    expect(addedLines(bugDiff)).toEqual([`if (one ${entry.operator} two) { merge(); }`]);
  });

  test("plants in a root commit, and handles a path with spaces and a comma", async () => {
    const base = tmp("root");
    const { dir: src, shas } = sourceRepo("root", [
      { file: "we,ird name.txt", content: "if (x < y) { swap(); }\n", message: "root adds comparison" },
    ]);

    const copy = join(base, "copy");
    const result = await plant({ sourceRepo: src, outDir: copy, keyPath: join(base, "key.json"), commits: [at(shas, 0)], seed: 5 });

    const entry = byFile(result, "we,ird name.txt");
    expect(entry.line).toBe(1);
    expect(entry.originalOperator).toBe("<");
    expect(git(copy, ["show", "-s", "--format=%P", entry.commit])).toBe("");
    expect(git(copy, ["rev-list", "--count", "HEAD"])).toBe("2");
    expect(git(copy, ["show", `${entry.commit}:we,ird name.txt`])).toBe(`if (x ${entry.operator} y) { swap(); }`);
    expect(readFileSync(join(copy, "we,ird name.txt"), "utf8")).toBe("if (x < y) { swap(); }\n");
  });

  test("an empty commit list copies the repo without planting anything", async () => {
    const base = tmp("empty");
    const { dir: src, shas } = sourceRepo("empty", [
      { file: "README.md", content: "# repo\n", message: "initial commit" },
      { file: "a.txt", content: "if (a < 2) {}\n", message: "add comparison" },
    ]);

    const copy = join(base, "copy");
    const keyPath = join(base, "key.json");
    const result = await plant({ sourceRepo: src, outDir: copy, keyPath, commits: [], seed: 9 });

    expect(result.planted).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(git(copy, ["rev-parse", "HEAD"])).toBe(at(shas, 1));
    expect(JSON.parse(readFileSync(keyPath, "utf8")).planted).toEqual([]);
  });

  test("refuses a key path inside the copy", async () => {
    const base = tmp("key");
    const { dir: src, shas } = sourceRepo("key", [{ file: "a.txt", content: "if (a < 2) {}\n", message: "add comparison" }]);
    const copy = join(base, "copy");

    await expect(
      plant({ sourceRepo: src, outDir: copy, keyPath: join(copy, "key.json"), commits: [at(shas, 0)], seed: 1 }),
    ).rejects.toThrow(/outside outDir/);
    expect(existsSync(copy)).toBe(false);
  });

  test("refuses an outDir that already has content", async () => {
    const base = tmp("outdir");
    const { dir: src } = sourceRepo("outdir", [{ file: "a.txt", content: "if (a < 2) {}\n", message: "add comparison" }]);
    const copy = join(base, "copy");
    mkdirSync(copy, { recursive: true });
    writeFileSync(join(copy, "keep.txt"), "keep\n");

    await expect(
      plant({ sourceRepo: src, outDir: copy, keyPath: join(base, "key.json"), commits: [], seed: 1 }),
    ).rejects.toThrow(/not empty/);
  });
});

describe("scanOperators", () => {
  test("finds comparisons outside strings and comments", () => {
    expect(scanOperators("if (a < 2) {")).toEqual([{ index: 6, operator: "<" }]);
    expect(scanOperators("if (a >= 2 && b != c)").map((h) => h.operator)).toEqual([">=", "!="]);
    expect(scanOperators('const s = "a < b"; // x > y')).toEqual([]);
    expect(scanOperators("const s = 'a <= b';")).toEqual([]);
    expect(scanOperators("value = a <= b;")).toEqual([{ index: 10, operator: "<=" }]);
  });

  test("ignores operators that only extend a longer token", () => {
    expect(scanOperators("a === b")).toEqual([]);
    expect(scanOperators("a !== b")).toEqual([]);
    expect(scanOperators("const f = (a) => b;")).toEqual([]);
    expect(scanOperators("ptr -> next")).toEqual([]);
    expect(scanOperators("x << 2")).toEqual([]);
    expect(scanOperators("x >> 2")).toEqual([]);
  });
});
