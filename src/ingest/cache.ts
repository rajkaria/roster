// Cache parsed sessions by checkpoint state (DESIGN.md §"Ingest").
// A cache key is derived from the repo and a digest of its checkpoint refs, so a repo whose
// checkpoints did not move is not re-parsed. Entries live one file per key under `dir`.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Compare two strings by code unit, so the digest does not depend on the locale. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * sha256 over `<name>=<sha>` lines sorted by name, so the same set of refs always digests the
 * same regardless of the order git listed them in.
 */
export function refsDigest(refs: { name: string; sha: string }[]): string {
  const lines = refs
    .map((r) => ({ name: r.name, line: r.name + "=" + r.sha }))
    .sort((a, b) => cmp(a.name, b.name) || cmp(a.line, b.line))
    .map((r) => r.line);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** A key may be used as a filename only when it is one path segment that cannot leave `dir`. */
function isSafeKey(key: string): boolean {
  return key.length > 0 && key !== "." && key !== ".." && !key.includes("..") && /^[A-Za-z0-9._-]+$/.test(key);
}

/** Sessions parsed from one repo's checkpoints, cached per (repo, refs) pair. */
export class SessionCache {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** A filesystem-safe name for the (repo, refs) pair; the same pair always maps to the same key. */
  key(repo: string, refsDigest: string): string {
    return createHash("sha256").update(repo + "\n" + refsDigest).digest("hex");
  }

  /** The cached sessions for `key`, or null when the entry is missing or unreadable. */
  async get(key: string): Promise<unknown[] | null> {
    if (!isSafeKey(key)) return null;
    const file = join(this.dir, key);

    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return null; // no entry, or a directory we cannot read: both are a miss
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through: malformed JSON is corrupt
    }

    // Corrupt entries are deleted so the next get is a clean miss instead of a repeat failure.
    await rm(file, { force: true }).catch(() => {});
    return null;
  }

  /** Write `sessions` for `key`, replacing any previous entry. The write is atomic. */
  async set(key: string, sessions: unknown[]): Promise<void> {
    if (!isSafeKey(key)) throw new Error("unsafe cache key: " + JSON.stringify(key));
    await mkdir(this.dir, { recursive: true });

    // Write beside the target and rename, so a reader never sees a half-written entry.
    const tmp = join(this.dir, "." + key + "." + randomUUID() + ".tmp");
    try {
      await writeFile(tmp, JSON.stringify(sessions));
      await rename(tmp, join(this.dir, key));
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }
}
