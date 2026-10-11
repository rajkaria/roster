import { runGit } from "../sandbox/index.ts";

export interface HiddenTest {
  /** Repo-relative path. */
  path: string;
  content: string;
  /**
   * A helper the hidden tests import (a fixture builder, sample data) rather than a test file. It is written into the
   * grading copy so the tests can import it, but it is not a test case of its own.
   */
  support?: true;
}

const TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/;
/** Files that hold test cases: a test name, or anything in a `__tests__/` directory (jest's convention). */
const TEST_CASE_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$|(^|\/)__tests__\//;
/** Directories whose other files are helpers the tests can import. */
const SUPPORT_DIR = /(^|\/)(tests?|__tests__|fixtures)\//;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

/** Paths a commit changed with the given `--diff-filter` letters (e.g. "AM"). */
function changedIn(repo: string, sha: string, filter: string): string[] {
  return runGit(repo, ["diff-tree", "--root", "--no-commit-id", "-r", "--name-only", `--diff-filter=${filter}`, "-z", sha])
    .split("\0")
    .filter(Boolean);
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
 * The hidden tests for a set of session commits, at the version the session left (`latest` decides which commit's
 * tree that is). Test cases: test files the commits added or modified. Support: other files the commits added or
 * modified under a test directory (fixtures, helpers), which the tests may import. Support comes only with at least
 * one test case, so a session that added only a helper stays judge-only. Files deleted by then are dropped.
 */
function collect(repo: string, commitShas: string[], latest: string): HiddenTest[] {
  const tests = new Set<string>();
  const support = new Set<string>();
  for (const sha of commitShas) {
    for (const p of changedIn(repo, sha, "AM")) {
      if (TEST_CASE_FILE.test(p)) tests.add(p);
      else if (SUPPORT_DIR.test(p)) support.add(p);
    }
  }
  if (tests.size === 0) return [];
  const at = acceptedAt(repo, latest);
  return [
    ...readAt(repo, at, [...tests]),
    ...readAt(repo, at, [...support]).map((s) => ({ ...s, support: true as const })),
  ];
}

/**
 * Test files the original change added or modified, as they were when the change landed: at that commit,
 * or at the merge commit that brought it into the main line. Later edits by other tasks are not applied.
 * Files deleted by then are dropped.
 */
export function hiddenTests(repo: string, originalSha: string): HiddenTest[] {
  return collect(repo, [originalSha], originalSha);
}

/**
 * Test files and their support files added or modified (A/M) across all of a session's commits, deduplicated by
 * path, read at the latest of them (the one furthest along HEAD's history), or at the merge commit that brought
 * it into the main line. Files deleted by then are dropped.
 */
export function hiddenTestsForCommits(repo: string, commitShas: string[]): HiddenTest[] {
  if (commitShas.length === 0) return [];
  const head = runGit(repo, ["rev-list", "--reverse", "HEAD"]).split("\n").filter(Boolean);
  const position = new Map(head.map((s, i) => [s, i]));
  const latest = commitShas.reduce((a, b) => ((position.get(b) ?? -1) >= (position.get(a) ?? -1) ? b : a));
  return collect(repo, commitShas, latest);
}
