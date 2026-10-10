import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { survival } from "../src/score/survival.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function lines(prefix: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join("\n") + "\n";
}

function setup(): string {
  const d = mkdtempSync(join(tmpdir(), "roster-surv-"));
  dirs.push(d);
  git(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "README.md"), "base\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "base");
  return d;
}

function commit(d: string, msg: string): string {
  git(d, "add", "-A");
  git(d, "commit", "-qm", msg);
  return git(d, "rev-parse", "HEAD");
}

describe("survival", () => {
  test("untouched commit → ratio 1", () => {
    const d = setup();
    writeFileSync(join(d, "a.ts"), lines("alpha line", 10));
    const c = commit(d, "add a");
    const head = git(d, "rev-parse", "HEAD");
    expect(survival(d, [c], head)).toEqual({ added: 10, surviving: 10, ratio: 1 });
  });

  test("half rewritten later → ratio 0.5 (±1 line)", () => {
    const d = setup();
    writeFileSync(join(d, "a.ts"), lines("alpha line", 10));
    const c = commit(d, "add a");
    const kept = lines("alpha line", 10).split("\n").slice(0, 5).join("\n") + "\n";
    writeFileSync(join(d, "a.ts"), kept + lines("different content", 5));
    const head = commit(d, "rewrite half");
    const r = survival(d, [c], head);
    expect(r.added).toBe(10);
    expect(Math.abs(r.surviving - 5)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.ratio - 0.5)).toBeLessThanOrEqual(0.1);
  });

  test("reverted commit → 0", () => {
    const d = setup();
    writeFileSync(join(d, "a.ts"), lines("alpha line", 10));
    const c = commit(d, "add a");
    git(d, "revert", "--no-edit", c);
    const head = git(d, "rev-parse", "HEAD");
    expect(survival(d, [c], head)).toEqual({ added: 10, surviving: 0, ratio: 0 });
  });

  test("whitespace-only reindent by a later commit does not steal lines (-w)", () => {
    const d = setup();
    writeFileSync(join(d, "a.ts"), lines("alpha line", 4));
    const c = commit(d, "add a");
    writeFileSync(join(d, "a.ts"), lines("alpha line", 4).replace(/^/gm, "    "));
    const head = commit(d, "indent");
    expect(survival(d, [c], head).ratio).toBe(1);
  });

  test("generated files are ignored; whitespace-only added lines are not counted", () => {
    const d = setup();
    mkdirSync(join(d, "dist"));
    writeFileSync(join(d, "dist/out.js"), lines("built", 20));
    writeFileSync(join(d, "bun.lock"), lines("lock", 20));
    writeFileSync(join(d, "app.min.js"), lines("min", 20));
    writeFileSync(join(d, "a.ts"), "one\n\n   \ntwo\n");
    const c = commit(d, "mixed");
    const head = git(d, "rev-parse", "HEAD");
    expect(survival(d, [c], head)).toEqual({ added: 2, surviving: 2, ratio: 1 });
  });

  test("multiple commits aggregate; no added lines → ratio 1 with added 0", () => {
    const d = setup();
    writeFileSync(join(d, "a.ts"), lines("a", 4));
    const c1 = commit(d, "a");
    writeFileSync(join(d, "b.ts"), lines("b", 6));
    const c2 = commit(d, "b");
    const head = git(d, "rev-parse", "HEAD");
    expect(survival(d, [c1, c2], head)).toEqual({ added: 10, surviving: 10, ratio: 1 });
    expect(survival(d, [], head)).toEqual({ added: 0, surviving: 0, ratio: 1 });
  });
});
