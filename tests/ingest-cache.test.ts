import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionCache, refsDigest } from "../src/ingest/cache";

const ref = (name: string, sha: string) => ({ name, sha });

describe("refsDigest", () => {
  test("is a sha256 over name=sha lines sorted by name", () => {
    const expected = createHash("sha256").update("a=sha-a\nb=sha-b\nc=sha-c").digest("hex");
    expect(refsDigest([ref("b", "sha-b"), ref("a", "sha-a"), ref("c", "sha-c")])).toBe(expected);
  });

  test("ignores the order refs were listed in", () => {
    const forwards = [ref("refs/entire/checkpoints/1", "aaa"), ref("refs/entire/checkpoints/2", "bbb")];
    expect(refsDigest(forwards)).toBe(refsDigest([...forwards].reverse()));
  });

  test("changes when a sha moves, and when a ref is added or dropped", () => {
    const base = [ref("a", "1"), ref("b", "2")];
    expect(refsDigest(base)).not.toBe(refsDigest([ref("a", "1"), ref("b", "3")]));
    expect(refsDigest(base)).not.toBe(refsDigest([ref("a", "1")]));
    expect(refsDigest(base)).not.toBe(refsDigest([...base, ref("c", "4")]));
  });

  test("does not mutate its input", () => {
    const refs = [ref("b", "2"), ref("a", "1")];
    refsDigest(refs);
    expect(refs).toEqual([ref("b", "2"), ref("a", "1")]);
  });

  test("handles the empty ref list", () => {
    expect(refsDigest([])).toBe(createHash("sha256").update("").digest("hex"));
  });
});

describe("SessionCache", () => {
  let dir: string;
  let cache: SessionCache;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "roster-cache-"));
    cache = new SessionCache(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const sessions = [{ id: "s1" }, { id: "s2", nested: { ok: true } }];

  test("round-trips sessions", async () => {
    const key = cache.key("owner/repo", refsDigest([ref("a", "1")]));
    await cache.set(key, sessions);
    expect(await cache.get(key)).toEqual(sessions);
  });

  test("key is stable per (repo, refs) and changes with either", () => {
    const digest = refsDigest([ref("a", "1")]);
    expect(cache.key("owner/repo", digest)).toBe(cache.key("owner/repo", digest));
    expect(cache.key("owner/repo", digest)).not.toBe(cache.key("other/repo", digest));
    expect(cache.key("owner/repo", digest)).not.toBe(cache.key("owner/repo", refsDigest([ref("a", "2")])));
  });

  test("key is filesystem-safe even for a hostile repo name", () => {
    const digest = refsDigest([ref("a", "1")]);
    for (const repo of ["../../etc/passwd?x=y", "C:\\windows\\system32", "a/b\0c", ".."]) {
      const key = cache.key(repo, digest);
      expect(key.length).toBeGreaterThan(0);
      expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(key).not.toContain("/");
      expect(key).not.toContain("\\");
      expect(key).not.toContain("\0");
      expect(key).not.toContain("..");
    }
  });

  test("get misses cleanly on a missing entry", async () => {
    expect(await cache.get(cache.key("owner/repo", refsDigest([ref("a", "1")])))).toBeNull();
  });

  test("get misses when the cache directory does not exist", async () => {
    const fresh = new SessionCache(join(dir, "not-created-yet"));
    expect(await fresh.get(cache.key("owner/repo", refsDigest([ref("a", "1")])))).toBeNull();
  });

  test.each(["not json at all", "{\"half\":", "null", "{\"not\":\"an array\"}", "\"str\"", "42"])(
    "get returns null and deletes a corrupt entry (%s)",
    async (payload) => {
      const key = cache.key("owner/repo", refsDigest([ref("a", "1")]));
      const file = join(dir, key);
      await writeFile(file, payload);

      expect(await cache.get(key)).toBeNull();

      const exists = await stat(file).then(() => true).catch(() => false);
      expect(exists).toBe(false);
      expect(await readdir(dir)).toEqual([]);
    },
  );

  test("set overwrites the previous entry completely", async () => {
    const key = cache.key("owner/repo", refsDigest([ref("a", "1")]));
    await cache.set(key, [{ id: "old" }, { id: "also-old" }]);
    await cache.set(key, [{ id: "new" }]);
    expect(await cache.get(key)).toEqual([{ id: "new" }]);
  });

  test("set leaves no temporary files behind", async () => {
    const key = cache.key("owner/repo", refsDigest([ref("a", "1")]));
    await cache.set(key, sessions);
    await cache.set(key, sessions);
    expect(await readdir(dir)).toEqual([key]);
    expect(JSON.parse(await readFile(join(dir, key), "utf8"))).toEqual(sessions);
  });

  test("creates the cache directory on first set", async () => {
    const nested = join(dir, "a", "b");
    const fresh = new SessionCache(nested);
    const key = fresh.key("owner/repo", refsDigest([ref("a", "1")]));
    await fresh.set(key, sessions);
    expect(await fresh.get(key)).toEqual(sessions);
  });

  test("refuses an unsafe key instead of writing outside the directory", async () => {
    await expect(cache.set("../escape", sessions)).rejects.toThrow();
    await expect(cache.set("a/b", sessions)).rejects.toThrow();
    await expect(cache.get("../escape")).resolves.toBeNull();
    await expect(cache.get("..")).resolves.toBeNull();
  });
});
