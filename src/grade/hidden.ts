import { runGit } from "../sandbox/index.ts";

export interface HiddenTest {
  /** Repo-relative path. */
  path: string;
  content: string;
}

/** Commits after the original change before its lines count as accepted. */
const MATURITY_COMMITS = 5;

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

/** The commit where lines made at `sha` count as mature: the 5th commit after it on HEAD's history, or HEAD when the history is shorter. */
function matureAt(repo: string, sha: string): string {
  const later = runGit(repo, ["rev-list", "--reverse", `${sha}..HEAD`]).split("\n").filter(Boolean);
  return later.length >= MATURITY_COMMITS ? later[MATURITY_COMMITS - 1]! : (later.at(-1) ?? sha);
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
 * Test files the original change added or modified, at the commit where those lines matured:
 * the 5th commit after it on HEAD's history, or HEAD when the history is shorter.
 * Files deleted by then are dropped.
 */
export function hiddenTests(repo: string, originalSha: string): HiddenTest[] {
  return readAt(repo, matureAt(repo, originalSha), testFilesChangedIn(repo, originalSha));
}

/**
 * Test files added or modified (A/M) across all of a session's commits, deduplicated by path,
 * read at the maturity commit after the latest of them (the one furthest along HEAD's history).
 * Files deleted by then are dropped.
 */
export function hiddenTestsForCommits(repo: string, commitShas: string[]): HiddenTest[] {
  if (commitShas.length === 0) return [];
  const paths = new Set<string>();
  for (const sha of commitShas) for (const p of testFilesChangedIn(repo, sha)) paths.add(p);
  const head = runGit(repo, ["rev-list", "--reverse", "HEAD"]).split("\n").filter(Boolean);
  const position = new Map(head.map((s, i) => [s, i]));
  const latest = commitShas.reduce((a, b) => ((position.get(b) ?? -1) >= (position.get(a) ?? -1) ? b : a));
  return readAt(repo, matureAt(repo, latest), [...paths]);
}
