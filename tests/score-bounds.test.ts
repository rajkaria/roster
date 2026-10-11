// T58: scoring is bounded. Every git call has a timeout, big or generated files are not blamed, and the whole
// scoring pass has a time budget. Runners are injected, so nothing here waits for a real hang.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoreAll } from "../src/cli/review.ts";
import { parseCheckpoints } from "../src/ingest/parse.ts";
import { gitPool, spawnGit, type GitRunner } from "../src/score/rework.ts";
import { skipReason, survivalMany } from "../src/score/survival.ts";
import { git, makeFixture } from "./fixtures/make-fixture.ts";

const root = mkdtempSync(join(tmpdir(), "roster-score-bounds-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const never: GitRunner = () => new Promise(() => {});

function repoWith(files: Record<string, string>): { repo: string; sha: string } {
  const repo = mkdtempSync(join(root, "r-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@t.invalid"]);
  git(repo, ["config", "user.name", "t"]);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "c"]);
  return { repo, sha: git(repo, ["rev-parse", "HEAD"]).trim() };
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `const x${i} = ${i};`).join("\n") + "\n";

describe("git timeout", () => {
  test("a call that never returns is cut off at the timeout", async () => {
    const t = performance.now();
    const r = await gitPool(never, 8, 50)("/", ["status"]);
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(performance.now() - t).toBeLessThan(2000);
  });

  test("a hung session is marked not scored", async () => {
    const { repo, sha } = repoWith({ "a.ts": lines(3) });
    const run = gitPool((r, args, stdin) => (args.includes("blame") ? never(r, args) : spawnGit(r, args, stdin)), 8, 100);
    const [res] = await survivalMany(repo, [[sha]], sha, run);
    expect(res).toBeInstanceOf(Error);
    expect((res as Error).message).toContain("timed out");
  });
});

describe("files that are not blamed", () => {
  test("skipReason by path", () => {
    expect(skipReason("vendor/x.go")).toBeTruthy();
    expect(skipReason("a/node_modules/b.js")).toBeTruthy();
    expect(skipReason("build/out.js")).toBeTruthy();
    expect(skipReason("app.min.js")).toBeTruthy();
    expect(skipReason("yarn.lock")).toBeTruthy();
    expect(skipReason("n.ipynb")).toBeTruthy();
    expect(skipReason("data.csv")).toBeTruthy();
    expect(skipReason("src/a.ts")).toBeNull();
  });

  test("a 6,000-line file is skipped with a reason, and is not blamed", async () => {
    const { repo, sha } = repoWith({ "big.ts": lines(6000), "small.ts": lines(4) });
    const calls: string[][] = [];
    const run: GitRunner = (r, args, stdin) => (calls.push(args), spawnGit(r, args, stdin));
    const res = (await survivalMany(repo, [[sha]], sha, gitPool(run)))[0]!;
    if (res instanceof Error) throw res;
    expect(res.added).toBe(4);
    expect(res.ratio).toBe(1);
    expect(res.skipped).toEqual([{ file: "big.ts", reason: expect.stringContaining("5000 lines") }]);
    expect(calls.some((a) => a.includes("blame") && a.at(-1) === "big.ts")).toBe(false);
  });

  test("a session whose files are all skipped is not scored", async () => {
    const { repo, sha } = repoWith({ "big.ts": lines(6000) });
    const [res] = await survivalMany(repo, [[sha]], sha);
    expect(res).toBeInstanceOf(Error);
    expect((res as Error).message).toContain("not_scored");
  });
});

describe("the whole-review scoring budget", () => {
  const repo = join(root, "fx");
  makeFixture(repo, "basic");
  const sessions = parseCheckpoints(repo, "auto", { warn: () => {} });
  const head = git(repo, ["rev-parse", "HEAD"]).trim();
  const ctx = { repo, head, headTime: Number(git(repo, ["show", "-s", "--format=%ct", head]).trim()) };

  test("sessions left when the budget runs out are not_scored: time budget", async () => {
    const out = await scoreAll(sessions, ctx, gitPool(never, 8, 60_000), { budgetMs: 50 });
    expect(out).toHaveLength(sessions.length);
    const withCommit = sessions.map((s, i) => [s, out[i]!] as const).filter(([s]) => s.commit_sha !== null);
    expect(withCommit.length).toBeGreaterThan(0);
    for (const [, o] of withCommit) {
      expect(o).toBeInstanceOf(Error);
      expect((o as Error).message).toBe("not_scored: time budget");
    }
  });

  test("progress is reported every 10 sessions with elapsed time", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ ...sessions[0]!, id: `s${i}` }));
    const seen: string[] = [];
    await scoreAll(many, ctx, gitPool(), { onProgress: (l) => seen.push(l) });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/^score: 10\/25 sessions, \d+\.\d s$/);
    expect(seen[1]).toMatch(/^score: 20\/25 sessions/);
  });
});
