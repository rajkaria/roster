import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchCheckpoints } from "../src/ingest/fetch";

const root = mkdtempSync(join(tmpdir(), "roster-fetch-"));
const fixture = join(root, "fixture");
const refsFixture = join(root, "fixture-refs");
const plain = join(root, "plain");
const cache = join(root, "cache");
const logs: string[] = [];
const opts = { cacheDir: cache, backoffMs: 1, log: (m: string) => logs.push(m) };

async function run(args: string[], cwd?: string) {
  const p = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(args.join(" ") + ": " + (await new Response(p.stderr).text()));
  return out.trim();
}
const g = (cwd: string, ...a: string[]) => run(["git", "-c", "user.name=t", "-c", "user.email=t@t.invalid", ...a], cwd);

beforeAll(async () => {
  await run(["bun", join(import.meta.dir, "fixtures/make-fixture.ts"), fixture]);
  // Refs variant: the same fixture with the checkpoint branch moved under refs/entire/checkpoints/.
  await run(["git", "clone", "-q", "--no-local", fixture, refsFixture]);
  await g(refsFixture, "fetch", "-q", "origin", "entire/checkpoints/v1:refs/entire/checkpoints/v1");
  await g(refsFixture, "branch", "-D", "-r", "origin/entire/checkpoints/v1");
  // Neither: a plain repo.
  await run(["git", "init", "-q", plain]);
  await g(plain, "commit", "-q", "--allow-empty", "-m", "init");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("branch backend on the T01 fixture", async () => {
  const r = await fetchCheckpoints(fixture, opts);
  expect(r.backend).toBe("branch");
  expect(r.headSha).toBe(await g(fixture, "rev-parse", "HEAD"));
  const tree = await g(r.repoPath, "ls-tree", "-r", "--name-only", "entire/checkpoints/v1");
  expect(tree).toContain("metadata.json");
});

test("refs backend", async () => {
  const r = await fetchCheckpoints(refsFixture, opts);
  expect(r.backend).toBe("refs");
  expect(await g(r.repoPath, "for-each-ref", "refs/entire/checkpoints/")).toContain("refs/entire/checkpoints/v1");
});

test("neither -> none", async () => {
  const r = await fetchCheckpoints(plain, opts);
  expect(r.backend).toBe("none");
  expect(r.headSha).toBe(await g(plain, "rev-parse", "HEAD"));
});

test("cache hit on same URL + HEAD, miss when HEAD moves", async () => {
  logs.length = 0;
  const a = await fetchCheckpoints(plain, opts);
  expect(logs.some((l) => l.includes("cache hit"))).toBe(true);
  await g(plain, "commit", "-q", "--allow-empty", "-m", "second");
  const b = await fetchCheckpoints(plain, opts);
  expect(b.repoPath).not.toBe(a.repoPath);
  expect(b.headSha).toBe(await g(plain, "rev-parse", "HEAD"));
});

test("a remote that allows blob filters still gives a clone with every blob (no lazy fetches while scoring)", async () => {
  // A local path ignores --filter, so serve the fixture over file:// with filtering allowed, the way GitHub does.
  await g(fixture, "config", "uploadpack.allowFilter", "true");
  await g(fixture, "config", "uploadpack.allowAnySHA1InWant", "true");
  const r = await fetchCheckpoints("file://" + fixture, opts);
  expect(r.backend).toBe("branch");
  const promisor = Bun.spawnSync(["git", "config", "--get", "remote.origin.promisor"], { cwd: r.repoPath });
  expect(promisor.stdout.toString().trim()).toBe("");
  const missing = await g(r.repoPath, "rev-list", "--objects", "--all", "--missing=print");
  expect(missing.split("\n").filter((l) => l.startsWith("?"))).toEqual([]);
});

test("failure retries twice with numbered attempts, then throws", async () => {
  logs.length = 0;
  await expect(fetchCheckpoints(join(root, "missing"), opts)).rejects.toThrow();
  expect(logs.filter((l) => l.includes("ls-remote: attempt") && !l.includes("failed"))).toEqual([
    "[fetch] ls-remote: attempt 1/3",
    "[fetch] ls-remote: attempt 2/3",
    "[fetch] ls-remote: attempt 3/3",
  ]);
});
