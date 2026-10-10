import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

export { proveIsolation } from "./isolation.ts";
export type { IsolationCheck, IsolationProof } from "./isolation.ts";

const BASE_DATE = "2000-01-01T00:00:00+00:00";

export function gitEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Roster",
    GIT_AUTHOR_EMAIL: "roster@example.invalid",
    GIT_AUTHOR_DATE: BASE_DATE,
    GIT_COMMITTER_NAME: "Roster",
    GIT_COMMITTER_EMAIL: "roster@example.invalid",
    GIT_COMMITTER_DATE: BASE_DATE,
  };
}

export function runGit(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv() });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

export interface Sandbox {
  path: string;
  baseSha: string;
}

/** Fresh workspace holding the tree of `commitSha` and no history from the source repo. */
export async function createSandbox(
  repoPath: string,
  commitSha: string,
  opts: { root: string },
): Promise<Sandbox> {
  mkdirSync(opts.root, { recursive: true });
  const path = mkdtempSync(join(opts.root, "sandbox-"));
  try {
    const r = Bun.spawnSync(
      ["bash", "-c", 'set -o pipefail; git -C "$1" archive "$2" | tar -x -C "$3"', "bash", repoPath, commitSha, path],
      { env: gitEnv() },
    );
    if (r.exitCode !== 0) throw new Error(`archive failed: ${r.stderr.toString().trim()}`);
    runGit(path, ["init", "-q", "-b", "main"]);
    runGit(path, ["add", "-A", "-f"]);
    runGit(path, ["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", `base: tree of ${commitSha}`]);
    return { path, baseSha: runGit(path, ["rev-parse", "HEAD"]) };
  } catch (e) {
    rmSync(path, { recursive: true, force: true });
    throw e;
  }
}

export async function destroySandbox(path: string): Promise<void> {
  rmSync(path, { recursive: true, force: true });
}
