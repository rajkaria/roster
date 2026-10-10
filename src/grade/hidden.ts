import { runGit } from "../sandbox/index.ts";

export interface HiddenTest {
  /** Repo-relative path. */
  path: string;
  content: string;
}

const TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

/** Test files a commit added or modified (A/M). */
function testFilesChangedIn(repo: string, sha: string): string[] {
  return runGit(repo, ["diff-tree", "--root", "--no-commit-id", "-r", "--name-only", "--diff-filter=AM", "-z", sha])
    .split("\0")
    .filter((p) => p && isTestFile(p));
}

/**
 * The commit whose tree holds the version the team accepted: `sha` itself when it is on HEAD's first-parent line,
 * otherwise the merge commit that brought it into that line. Falls back to `sha` when it is not reachable from HEAD.
 */
function acceptedAt(repo: string, sha: string): string {
  const mainLine = runGit(repo, ["rev-list", "--first-parent", "HEAD"]).split("\n");
  if (mainLine.includes(sha)) return sha;
  const merged = runGit(repo, ["rev-list", "--first-parent", "--ancestry-path", "--reverse", `${sha}..HEAD`])
    .split("\n")
    .filter(Boolean);
  return merged[0] ?? sha;
}

/** Reads each path at `at`; files missing there (deleted later) are dropped. */
function readAt(repo: string, at: string, paths: string[]): HiddenTest[] {
  const out: HiddenTest[] = [];
  for (const path of paths) {
    const r = Bun.spawnSync(["git", "show", `${at}:${path}`], { cwd: repo });
    if (r.exitCode === 0) out.push({ path, content: r.stdout.toString() });
  }
  return out;
}

/**
 * Test files the original change added or modified, as they were when the change landed: at that commit,
 * or at the merge commit that brought it into the main line. Later edits by other tasks are not applied.
 * Files deleted by then are dropped.
 */
export function hiddenTests(repo: string, originalSha: string): HiddenTest[] {
  return readAt(repo, acceptedAt(repo, originalSha),testFilesChangedIn(repo, originalSha));
}

/**
 * Test files added or modified (A/M) across all of a session's commits, deduplicated by path,
 * read at the latest of them (the one furthest along HEAD's history), or at the merge commit that brought
 * it into the main line. Files deleted by then are dropped.
 */
export function hiddenTestsForCommits(repo: string, commitShas: string[]): HiddenTest[] {
  if (commitShas.length === 0) return [];
  const paths = new Set<string>();
  for (const sha of commitShas) for (const p of testFilesChangedIn(repo, sha)) paths.add(p);
  const head = runGit(repo, ["rev-list", "--reverse", "HEAD"]).split("\n").filter(Boolean);
  const position = new Map(head.map((s, i) => [s, i]));
  const latest = commitShas.reduce((a, b) => ((position.get(b) ?? -1) >= (position.get(a) ?? -1) ? b : a));
  return readAt(repo, acceptedAt(repo, latest), [...paths]);
}
