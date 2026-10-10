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

/**
 * Test files the original change added or modified, at the commit where those lines matured:
 * the 5th commit after it on HEAD's history, or HEAD when the history is shorter.
 * Files deleted by then are dropped.
 */
export function hiddenTests(repo: string, originalSha: string): HiddenTest[] {
  const changed = runGit(repo, ["diff-tree", "--root", "--no-commit-id", "-r", "--name-only", "--diff-filter=AM", "-z", originalSha])
    .split("\0")
    .filter((p) => p && isTestFile(p));
  const later = runGit(repo, ["rev-list", "--reverse", `${originalSha}..HEAD`]).split("\n").filter(Boolean);
  const at = later.length >= MATURITY_COMMITS ? later[MATURITY_COMMITS - 1]! : (later.at(-1) ?? originalSha);
  const out: HiddenTest[] = [];
  for (const path of changed) {
    const r = Bun.spawnSync(["git", "show", `${at}:${path}`], { cwd: repo });
    if (r.exitCode === 0) out.push({ path, content: r.stdout.toString() });
  }
  return out;
}
