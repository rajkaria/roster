// Fetch Entire checkpoint data from a git URL or local path (DESIGN.md §"Ingest").
// Partial clone, then the `entire/checkpoints/v1` branch, else `refs/entire/checkpoints/*`.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type Backend = "branch" | "refs" | "none";

export interface FetchResult {
  repoPath: string;
  backend: Backend;
  headSha: string;
}

export interface FetchOptions {
  cacheDir: string;
  /** Extra attempts after the first one. Default 2. */
  retries?: number;
  /** Base backoff in ms, doubled per retry. Default 1000. */
  backoffMs?: number;
  log?: (msg: string) => void;
}

export const CHECKPOINT_BRANCH = "entire/checkpoints/v1";
export const CHECKPOINT_REFS = "refs/entire/checkpoints/";
const META_FILE = "roster-fetch.json";

type RetryOpts = Required<Omit<FetchOptions, "cacheDir">>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function git(args: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error("git " + args[0] + " failed (" + code + "): " + err.trim());
  return out;
}

/** Run `fn`, retrying on failure with exponential backoff; every attempt is logged. */
async function withRetry<T>(label: string, fn: () => Promise<T>, o: RetryOpts): Promise<T> {
  const total = o.retries + 1;
  for (let attempt = 1; ; attempt++) {
    o.log("[fetch] " + label + ": attempt " + attempt + "/" + total);
    try {
      return await fn();
    } catch (e) {
      if (attempt >= total) throw e;
      o.log("[fetch] " + label + ": attempt " + attempt + " failed (" + (e as Error).message + "); retrying");
      await sleep(o.backoffMs * 2 ** (attempt - 1));
    }
  }
}

const isRemote = (s: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[\w.-]+@[\w.-]+:/.test(s);

export async function fetchCheckpoints(source: string, opts: FetchOptions): Promise<FetchResult> {
  const o: RetryOpts = { retries: 2, backoffMs: 1000, log: (m) => console.error(m), ...opts };
  const src = isRemote(source) ? source : resolve(source);
  const branchRef = "refs/heads/" + CHECKPOINT_BRANCH;

  // One round trip: remote HEAD plus the two places checkpoint data can live.
  const lsOut = await withRetry("ls-remote", () => git(["ls-remote", src, "HEAD", branchRef, CHECKPOINT_REFS + "*"]), o);
  const lines = lsOut
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t") as [string, string]);
  const remoteHead = lines.find(([, ref]) => ref === "HEAD")?.[0] ?? "";
  const hasBranch = lines.some(([, ref]) => ref === branchRef);
  const hasRefs = lines.some(([, ref]) => ref.startsWith(CHECKPOINT_REFS));

  // Cache by URL + remote HEAD; the checkpoint refs are in the key so new checkpoints invalidate it.
  const key = createHash("sha256")
    .update(JSON.stringify([src, remoteHead, lines.filter(([, r]) => r !== "HEAD")]))
    .digest("hex")
    .slice(0, 24);
  const cacheDir = resolve(opts.cacheDir);
  const repoPath = join(cacheDir, key);
  const metaPath = join(repoPath, ".git", META_FILE);
  if (existsSync(metaPath)) {
    o.log("[fetch] cache hit " + key);
    return JSON.parse(readFileSync(metaPath, "utf8")) as FetchResult;
  }

  mkdirSync(cacheDir, { recursive: true });
  const tmp = repoPath + ".tmp-" + process.pid;
  await withRetry(
    "clone",
    async () => {
      rmSync(tmp, { recursive: true, force: true });
      await git(["clone", "--quiet", "--filter=blob:none", "--no-checkout", src, tmp]);
    },
    o,
  );

  let backend: Backend = "none";
  if (hasBranch) {
    const spec = "+" + CHECKPOINT_BRANCH + ":" + CHECKPOINT_BRANCH;
    await withRetry("fetch branch", () => git(["fetch", "--quiet", "origin", spec], tmp), o);
    backend = "branch";
  } else if (hasRefs) {
    const spec = "+" + CHECKPOINT_REFS + "*:" + CHECKPOINT_REFS + "*";
    await withRetry("fetch refs", () => git(["fetch", "--quiet", "origin", spec], tmp), o);
    backend = "refs";
  } else {
    o.log("[fetch] no Entire data: run `entire enable` in the source repo and push the checkpoints branch");
  }

  let headSha = "";
  try {
    headSha = (await git(["rev-parse", "HEAD"], tmp)).trim();
  } catch {
    // empty repository: no HEAD
  }

  const result: FetchResult = { repoPath, backend, headSha };
  writeFileSync(join(tmp, ".git", META_FILE), JSON.stringify(result));
  rmSync(repoPath, { recursive: true, force: true });
  renameSync(tmp, repoPath);
  return result;
}
