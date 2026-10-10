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
  const out = git(repo, ["log", "--first-parent", "--topo-order", "--reverse", "--format=%H %P%x1f%B%x1e", `${sha}..HEAD`]);
  return out
    .split("\x1e")
    .filter((rec) => rec.trim() !== "")
    .map((rec) => {
      const [head = "", body = ""] = rec.split("\x1f");
      const [commit = "", ...parents] = head.trim().split(" ");
      return { sha: commit, parent: parents[0] ?? EMPTY_TREE, body };
    })
    .filter((c) => descendants.has(c.sha));
}

function parentOf(repo: string, sha: string): string {
  const parents = git(repo, ["log", "-1", "--format=%P", sha]).trim().split(" ");
  return parents[0] || EMPTY_TREE;
}

/** Added and removed lines between two trees, read from hunk headers so that content like `--- x` is not mistaken for a header. */
function diffLines(repo: string, from: string, to: string): { added: LineKey[]; removed: LineKey[] } {
  const out = git(repo, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", "--no-prefix", from, to]);
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
  const later = laterCommits(repo, full);
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
    for (const [path, text] of diffLines(repo, c.parent, c.sha).removed) {
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
  const t = trackLines(repo, sha, window);
  if (t.added === 0) return { human: 0, agent: 0 };
  return { human: t.matchedHuman / t.added, agent: t.matchedAgent / t.added };
}
