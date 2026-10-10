// Tracks which lines a session's commit added and which later commits removed or replaced.
// DESIGN.md §"Score: reverted, rework". History is read along first parents only: a merge is
// diffed against its first parent, and the window walks first-parent commits after the landing.

export const DEFAULT_WINDOW = 20;
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const CHECKPOINT_TRAILER = /^Entire-Checkpoint:\s*\S+/m;

/** A line is identified by its path and text. */
type LineKey = [path: string, text: string];

export interface Tracked {
  /** Lines the commit added, against its first parent. */
  added: number;
  /** Added lines that a later commit in the window removed or replaced, by commits without a checkpoint trailer. */
  matchedHuman: number;
  /** The same, by commits with an Entire-Checkpoint trailer. */
  matchedAgent: number;
  /** Some later first-parent commit says `This reverts commit <sha>`. Not limited to the window. */
  explicitRevert: boolean;
}

interface Commit {
  sha: string;
  parent: string;
  body: string;
}

// ---------- git runner shared by the batch scorers ----------

export interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

/** Runs `git <args>` in `repo`. Injectable so tests can count the commands a review spawns. */
export type GitRunner = (repo: string, args: string[], stdin?: string) => Promise<GitResult>;

/** Git processes a review runs at once. */
export const GIT_PARALLEL = 8;

/** Spawns one git process and collects its output. */
export const spawnGit: GitRunner = async (repo, args, stdin) => {
  const p = Bun.spawn(["git", ...args], { cwd: repo, stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (stdin !== undefined && p.stdin) {
    p.stdin.write(stdin);
    p.stdin.end();
  }
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { ok: code === 0, out, err };
};

/** Wraps `run` so that at most `limit` commands are in flight. */
export function gitPool(run: GitRunner = spawnGit, limit: number = GIT_PARALLEL): GitRunner {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (repo, args, stdin) => {
    if (active >= limit) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await run(repo, args, stdin);
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** Like `git` below, through a runner. */
async function gitAsync(run: GitRunner, repo: string, args: string[], stdin?: string): Promise<string> {
  const r = await run(repo, args, stdin);
  if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${r.err.trim()}`);
  return r.out;
}

function git(repo: string, args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${p.stderr.toString().trim()}`);
  return p.stdout.toString();
}

function fullSha(repo: string, ref: string): string {
  return git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
}

/**
 * Commits after `sha` on the first-parent chain of HEAD, oldest first. Only descendants of `sha`
 * qualify, so a merge whose second parent carries `sha` is included. `--ancestry-path` is not
 * combined with `--first-parent`: that would drop the second-parent edge and miss the merge.
 */
function laterCommits(repo: string, sha: string): Commit[] {
  const descendants = new Set(git(repo, ["rev-list", "--ancestry-path", `${sha}..HEAD`]).split("\n"));
  const out = git(repo, ["log", ...LOG_FORMAT, `${sha}..HEAD`]);
  return parseLog(out).filter((c) => descendants.has(c.sha));
}

const LOG_FORMAT = ["--first-parent", "--topo-order", "--reverse", "--format=%H %P%x1f%B%x1e"];

function parseLog(out: string): Commit[] {
  return out
    .split("\x1e")
    .filter((rec) => rec.trim() !== "")
    .map((rec) => {
      const [head = "", body = ""] = rec.split("\x1f");
      const [commit = "", ...parents] = head.trim().split(" ");
      return { sha: commit, parent: parents[0] ?? EMPTY_TREE, body };
    });
}

function parentOf(repo: string, sha: string): string {
  const parents = git(repo, ["log", "-1", "--format=%P", sha]).trim().split(" ");
  return parents[0] || EMPTY_TREE;
}

interface DiffLines {
  added: LineKey[];
  removed: LineKey[];
}

const DIFF_FLAGS = ["-U0", "--no-color", "--no-ext-diff", "--no-renames", "--no-prefix"];

/** Added and removed lines between two trees. */
function diffLines(repo: string, from: string, to: string): DiffLines {
  return parseDiff(git(repo, ["diff", ...DIFF_FLAGS, from, to]));
}

/** Parses `-U0` diff text, read from hunk headers so that content like `--- x` is not mistaken for a header. */
function parseDiff(out: string): DiffLines {
  const added: LineKey[] = [];
  const removed: LineKey[] = [];
  let oldPath = "";
  let path = "";
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of out.split("\n")) {
    if (oldLeft > 0 && line.startsWith("-")) {
      removed.push([path, line.slice(1)]);
      oldLeft--;
    } else if (newLeft > 0 && line.startsWith("+")) {
      added.push([path, line.slice(1)]);
      newLeft--;
    } else if (line.startsWith("--- ")) {
      oldPath = line.slice(4).replace(/\t$/, "");
    } else if (line.startsWith("+++ ")) {
      const newPath = line.slice(4).replace(/\t$/, "");
      path = newPath === "/dev/null" ? oldPath : newPath;
    } else if (line.startsWith("@@ ")) {
      const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (!m) throw new Error(`unparsable diff hunk: ${line}`);
      oldLeft = m[1] === undefined ? 1 : Number(m[1]);
      newLeft = m[2] === undefined ? 1 : Number(m[2]);
    }
  }
  return { added, removed };
}

function bump(counts: Map<string, number>, key: string) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * Follows the lines `sha` added through the next `window` first-parent commits. A removed or
 * replaced line counts once, for the first later commit that removes it. Lines are matched by
 * path and text as multisets, so a line that is re-added later is not counted as surviving.
 */
export function trackLines(repo: string, sha: string, window: number = DEFAULT_WINDOW): Tracked {
  const full = fullSha(repo, sha);
  const { added } = diffLines(repo, parentOf(repo, full), full);
  return match(full, added, laterCommits(repo, full), window, (c) => diffLines(repo, c.parent, c.sha).removed);
}

/** Counts the added lines that the first `window` later commits remove. */
function match(full: string, added: LineKey[], later: Commit[], window: number, removedBy: (c: Commit) => LineKey[]): Tracked {
  const alive = new Map<string, number>();
  for (const [path, text] of added) bump(alive, `${path}\0${text}`);

  const result: Tracked = {
    added: added.length,
    matchedHuman: 0,
    matchedAgent: 0,
    explicitRevert: later.some((c) => c.body.includes(`This reverts commit ${full}`)),
  };
  if (added.length === 0) return result;

  for (const c of later.slice(0, window)) {
    const agent = CHECKPOINT_TRAILER.test(c.body);
    for (const [path, text] of removedBy(c)) {
      const key = `${path}\0${text}`;
      const n = alive.get(key) ?? 0;
      if (n === 0) continue;
      alive.set(key, n - 1);
      if (agent) result.matchedAgent++;
      else result.matchedHuman++;
    }
  }
  return result;
}

export interface ReworkShares {
  /** Share of the commit's added lines that later commits without a checkpoint trailer modified. */
  human: number;
  /** Share of the commit's added lines that later commits with a checkpoint trailer modified. */
  agent: number;
}

/** Shares of `sha`'s added lines that later first-parent commits in the window modified, split by author kind. */
export function rework(repo: string, sha: string, window: number = DEFAULT_WINDOW): ReworkShares {
  return reworkShares(trackLines(repo, sha, window));
}

export function reworkShares(t: Tracked): ReworkShares {
  if (t.added === 0) return { human: 0, agent: 0 };
  return { human: t.matchedHuman / t.added, agent: t.matchedAgent / t.added };
}

// ---------- batch: one history pass for every session of a review ----------

const COMMIT_MARK = /^\x1e([0-9a-f]+)$/;

/** First-parent diffs of `shas` from one `git log --no-walk -p` over exactly those commits. */
async function diffsOf(run: GitRunner, repo: string, shas: string[]): Promise<Map<string, DiffLines>> {
  const out = new Map<string, DiffLines>();
  if (shas.length === 0) return out;
  const text = await gitAsync(
    run,
    repo,
    ["log", "--no-walk=unsorted", "--stdin", "--root", "--diff-merges=first-parent", "-p", ...DIFF_FLAGS, "--format=%x1e%H"],
    shas.join("\n") + "\n",
  );
  let sha: string | null = null;
  let chunk: string[] = [];
  const flush = () => {
    if (sha !== null) out.set(sha, parseDiff(chunk.join("\n")));
  };
  for (const line of text.split("\n")) {
    const m = COMMIT_MARK.exec(line);
    if (m) {
      flush();
      sha = m[1]!;
      chunk = [];
    } else chunk.push(line);
  }
  flush();
  return out;
}

/**
 * `trackLines` for many commits at once, with the same results. HEAD's first-parent chain is read in
 * one `git log`, and the diffs of every commit in any window in one more; a commit off the chain also
 * needs its own `rev-list --ancestry-path`. `shas` must be full commit ids. A commit that cannot be
 * tracked maps to its Error.
 */
export async function trackMany(
  repo: string,
  shas: string[],
  run: GitRunner = gitPool(),
  window: number = DEFAULT_WINDOW,
): Promise<Map<string, Tracked | Error>> {
  const result = new Map<string, Tracked | Error>();
  const unique = [...new Set(shas)];
  if (unique.length === 0) return result;
  const chain = parseLog(await gitAsync(run, repo, ["log", ...LOG_FORMAT, "HEAD"]));
  const position = new Map(chain.map((c, i) => [c.sha, i]));

  // On the chain, the later commits are the rest of the chain. Off it (merged through a second
  // parent), they are the chain commits that descend from it.
  const later = new Map<string, Commit[]>();
  await Promise.all(
    unique.map(async (sha) => {
      const at = position.get(sha);
      if (at !== undefined) return later.set(sha, chain.slice(at + 1));
      try {
        const descendants = new Set((await gitAsync(run, repo, ["rev-list", "--ancestry-path", `${sha}..HEAD`])).split("\n"));
        later.set(sha, chain.filter((c) => descendants.has(c.sha)));
      } catch (err) {
        result.set(sha, err instanceof Error ? err : new Error(String(err)));
      }
    }),
  );

  const wanted = new Set<string>();
  for (const [sha, commits] of later) {
    wanted.add(sha);
    for (const c of commits.slice(0, window)) wanted.add(c.sha);
  }
  const diffs = await diffsOf(run, repo, [...wanted]);
  const diff = (sha: string): DiffLines => {
    const d = diffs.get(sha);
    if (!d) throw new Error(`git log -p did not return ${sha}`);
    return d;
  };
  for (const [sha, commits] of later) {
    try {
      result.set(sha, match(sha, diff(sha).added, commits, window, (c) => diff(c.sha).removed));
    } catch (err) {
      result.set(sha, err instanceof Error ? err : new Error(String(err)));
    }
  }
  return result;
}
