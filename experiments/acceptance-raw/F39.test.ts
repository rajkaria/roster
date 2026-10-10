import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { SessionCache, refsDigest } from "../../../src/ingest/cache.ts";

describe("F39 SessionCache", () => {
  let dir: string;
  let cache: SessionCache;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "f39-cache-"));
    cache = new SessionCache(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("refsDigest is a sha256 over name=sha lines sorted by name", () => {
    const refs = [
      { name: "b", sha: "sha-b" },
      { name: "a", sha: "sha-a" },
      { name: "c", sha: "sha-c" },
    ];
    const shuffled = [
      { name: "c", sha: "sha-c" },
      { name: "a", sha: "sha-a" },
      { name: "b", sha: "sha-b" },
    ];

    const expected = createHash("sha256")
      .update("a=sha-a\nb=sha-b\nc=sha-c")
      .digest("hex");

    expect(refsDigest(refs)).toBe(expected);
    expect(refsDigest(shuffled)).toBe(expected);
  });

  it("get returns null for a missing key", async () => {
    const digest = refsDigest([{ name: "a", sha: "sha-a" }]);
    const key = cache.key("owner/repo", digest);

    await expect(cache.get(key)).resolves.toBeNull();
  });

  it("get returns null for a corrupt file and deletes it", async () => {
    const digest = refsDigest([{ name: "a", sha: "sha-a" }]);
    const key = cache.key("owner/repo", digest);
    const file = join(dir, key);

    await writeFile(file, "this is not valid json");

    await expect(cache.get(key)).resolves.toBeNull();

    const exists = await stat(file)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("set writes the sessions so get can read them back", async () => {
    const digest = refsDigest([{ name: "a", sha: "sha-a" }]);
    const key = cache.key("owner/repo", digest);
    const sessions: unknown[] = [
      { id: "session-1", repo: "owner/repo", model: "gpt-4" },
      { id: "session-2", repo: "owner/repo", model: "claude" },
    ];

    await cache.set(key, sessions);

    await expect(cache.get(key)).resolves.toEqual(sessions);
  });

  it("set overwrites the previous value completely and writes atomically", async () => {
    const digest = refsDigest([{ name: "a", sha: "sha-a" }]);
    const key = cache.key("owner/repo", digest);
    const first: unknown[] = [{ id: "first" }];
    const second: unknown[] = [{ id: "second" }, { id: "third" }];

    await cache.set(key, first);
    await cache.set(key, second);

    await expect(cache.get(key)).resolves.toEqual(second);

    const raw = await readFile(join(dir, key), "utf8");
    expect(JSON.parse(raw)).toEqual(second);

    const files = await readdir(dir);
    expect(files).toEqual([key]);
  });

  it("keys are filesystem-safe", () => {
    const digest = refsDigest([{ name: "a", sha: "sha-a" }]);
    const key = cache.key("../../etc/passwd?x=y", digest);

    expect(key.length).toBeGreaterThan(0);
    expect(isAbsolute(key)).toBe(false);
    expect(key).not.toContain("/");
    expect(key).not.toContain("\\");
    expect(key).not.toContain("\0");
    expect(key.split(/[\/\\]/)).not.toContain("..");
  });
});
