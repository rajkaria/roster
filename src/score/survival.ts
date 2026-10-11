// Score: survival (DESIGN.md §"Score: survival"). Share of the lines a session's commit(s) added that
// `git blame -w -M -C HEAD` still attributes to those commits.

import { GIT_TIMEOUT_MS, gitFailure, gitPool, type GitRunner } from "./rework.ts";

export interface Survival {
  added: number;
  surviving: number;
  /** surviving ÷ added; 1 when nothing was added (nothing to lose). */
  ratio: number;
  /** Files left out of the counts because blame was skipped, with why. */
  skipped?: { file: string; reason: string }[];
}

/** Files longer than this are not blamed. */
export const MAX_BLAME_LINES = 5000;
/** Data files (`.json`) larger than this are not blamed. */
export const MAX_DATA_BYTES = 1024 * 1024;

const SKIP_PATH: [RegExp, string][] = [
  [/(^|\/)(dist|build|vendor|node_modules)\//, "generated or vendored path"],
  [/\.min\.[^/]*$/, "minified file"],
  [/\.lock$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|bun\.lockb|go\.sum)$/, "lockfile"],
  [/\.ipynb$/, "notebook"],
  [/\.csv$/, "data file"],
];

/** Why a file is not blamed judging by its path alone, or null. */
export function skipReason(path: string): string | null {
  return SKIP_PATH.find(([re]) => re.test(path))?.[1] ?? null;
}

/** Why a file with this content is not blamed, or null. */
function contentSkipReason(path: string, blob: string, bytes: number): string | null {
  if (blob.slice(0, 8000).includes("\0")) return "binary file";
  if (/\.json$/.test(path) && bytes > MAX_DATA_BYTES) return "data file over 1 MB";
  const lines = blob.split("\n").length - 1;
  return lines > MAX_BLAME_LINES ? `over ${MAX_BLAME_LINES} lines (${lines})` : null;
}

const GENERATED = [
  /(^|\/)dist\//,
  /\.min\.[^/]*$/,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/,
];

export function isGenerated(path: string): boolean {
  return GENERATED.some((re) => re.test(path));
}

function git(repo: string, args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["git", "-c", "core.quotepath=off", ...args], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
    maxBuffer: 256 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (r.exitedDueToTimeout) throw new Error(`git ${args[0]} timed out`);
  return { ok: r.exitCode === 0, out: r.stdout.toString() };
}

const SHOW = ["show", "-w", "--ignore-blank-lines", "-U0", "--no-renames", "--format="];
const BLAME = ["blame", "-w", "-M", "-C", "--line-porcelain"];

/** Added (non-blank, whitespace-insensitive) line count per non-generated file for one commit. */
function addedByFile(repo: string, sha: string): Map<string, number> {
  const res = git(repo, [...SHOW, sha]);
  if (!res.ok) throw new Error(`git show ${sha} failed in ${repo}`);
  return parseAdded(res.out);
}

function parseAdded(out: string): Map<string, number> {
  const counts = new Map<string, number>();
  let file: string | null = null;
  let inHunk = false;
  for (const line of out.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = null;
      inHunk = false;
    } else if (!inHunk && line.startsWith("+++ ")) {
      file = line === "+++ /dev/null" ? null : line.slice(6);
    } else if (line.startsWith("@@")) {
      inHunk = true;
    } else if (inHunk && file && line.startsWith("+") && line.trim().length > 1 && !isGenerated(file)) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }
  return counts;
}

// Blame cache: repo + resolved HEAD + file → line count per full commit sha.
const blameCache = new Map<string, Map<string, number>>();

function blameCounts(repo: string, head: string, file: string): Map<string, number> {
  const key = `${repo}\0${head}\0${file}`;
  const hit = blameCache.get(key);
  if (hit) return hit;
  const res = git(repo, [...BLAME, head, "--", file]);
  const counts = parseBlame(res);
  blameCache.set(key, counts);
  return counts;
}

/** A failed blame (the file is gone at HEAD) attributes nothing. */
function parseBlame(res: { ok: boolean; out: string }): Map<string, number> {
  const counts = new Map<string, number>();
  if (res.ok) {
    // Each blamed line starts with "<40-hex sha> <orig> <final> [<group size>]"; content lines start with a tab.
    for (const line of res.out.split("\n")) {
      if (/^[0-9a-f]{40} \d+ \d+/.test(line)) {
        const sha = line.slice(0, 40);
        counts.set(sha, (counts.get(sha) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function resolve(repo: string, rev: string): string {
  const r = git(repo, ["rev-parse", "--verify", `${rev}^{commit}`]);
  if (!r.ok) throw new Error(`cannot resolve ${rev} in ${repo}`);
  return r.out.trim();
}

export function survival(repoPath: string, commitShas: string[], headSha: string): Survival {
  const head = resolve(repoPath, headSha);
  const shas = new Set(commitShas.map((s) => resolve(repoPath, s)));

  const added = new Map<string, number>();
  for (const sha of shas) {
    for (const [file, n] of addedByFile(repoPath, sha)) added.set(file, (added.get(file) ?? 0) + n);
  }

  return tally(added, shas, (file) => blameCounts(repoPath, head, file));
}

function tally(added: Map<string, number>, shas: Set<string>, blamed: (file: string) => Map<string, number>): Survival {
  let total = 0;
  let surviving = 0;
  for (const [file, n] of added) {
    total += n;
    const counts = blamed(file);
    let mine = 0;
    for (const sha of shas) mine += counts.get(sha) ?? 0;
    surviving += Math.min(mine, n);
  }
  return { added: total, surviving, ratio: total === 0 ? 1 : surviving / total };
}

// ---------- batch: one blame per (file, HEAD) for a whole review ----------

/** Blame line counts per `repo + HEAD + file`, shared by every session of one review. */
export type BlameCache = Map<string, Promise<Map<string, number>>>;

/**
 * `survival` for many commit sets at once, with the same results. `head` and every sha must be full
 * commit ids. Each commit's diff is read once; `git blame` runs at most once per (file, head) across
 * all sets, and through `cache` across calls. A set that cannot be scored maps to its Error.
 */
export async function survivalMany(
  repoPath: string,
  sets: string[][],
  head: string,
  run: GitRunner = gitPool(),
  cache: BlameCache = new Map(),
  onSet: (index: number) => void = () => {},
): Promise<(Survival | Error)[]> {
  const quoted = (args: string[]) => ["-c", "core.quotepath=off", ...args];
  const shows = new Map<string, Promise<Map<string, number>>>();
  const addedOf = (sha: string) => {
    let p = shows.get(sha);
    if (!p) {
      p = run(repoPath, quoted([...SHOW, sha])).then((res) => {
        if (!res.ok) throw gitFailure(res, `git show ${sha}`);
        return parseAdded(res.out);
      });
      shows.set(sha, p);
    }
    return p;
  };
  const blameOf = (file: string) => {
    const key = `${repoPath}\0${head}\0${file}`;
    let p = cache.get(key);
    if (!p) {
      p = run(repoPath, quoted([...BLAME, head, "--", file])).then((res) => {
        if (res.timedOut || res.budget) throw gitFailure(res, `git blame ${file}`);
        return parseBlame(res);
      });
      cache.set(key, p);
    }
    return p;
  };
  // Why a file is not blamed (null: blame it). A file gone at HEAD has no blob and is left to blame.
  const skips = new Map<string, Promise<string | null>>();
  const skipOf = (file: string) => {
    let p = skips.get(file);
    if (!p) {
      const byPath = skipReason(file);
      p =
        byPath !== null
          ? Promise.resolve(byPath)
          : run(repoPath, ["cat-file", "blob", `${head}:${file}`]).then((res) => {
              if (res.timedOut || res.budget) throw gitFailure(res, `git cat-file ${file}`);
              return res.ok ? contentSkipReason(file, res.out, res.out.length) : null;
            });
      skips.set(file, p);
    }
    return p;
  };

  return Promise.all(
    sets.map(async (set, index) => {
      try {
        const shas = new Set(set);
        const added = new Map<string, number>();
        for (const perFile of await Promise.all([...shas].map(addedOf))) {
          for (const [file, n] of perFile) added.set(file, (added.get(file) ?? 0) + n);
        }
        const skipped: { file: string; reason: string }[] = [];
        for (const file of [...added.keys()]) {
          const reason = await skipOf(file);
          if (reason !== null) {
            skipped.push({ file, reason });
            added.delete(file);
          }
        }
        if (added.size === 0 && skipped.length > 0) {
          throw new Error(`not_scored: every changed file was skipped (${skipped.map((s) => `${s.file}: ${s.reason}`).join("; ")})`);
        }
        const files = [...added.keys()];
        const blamed = new Map((await Promise.all(files.map(blameOf))).map((c, i) => [files[i]!, c]));
        const result = tally(added, shas, (file) => blamed.get(file)!);
        return skipped.length > 0 ? { ...result, skipped } : result;
      } catch (err) {
        return err instanceof Error ? err : new Error(String(err));
      } finally {
        onSet(index);
      }
    }),
  );
}
