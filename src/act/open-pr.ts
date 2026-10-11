// Opening a pull request safely (DESIGN.md §"Act"): Roster opens a PR only on a repo whose owner opted in, and a
// dry run returns the command instead of running it.
//
//   const r = await openPr({ repoPath, branch, title, body, allowRepo, run });
//
// Never throws for a git or gh failure: that is `opened: false` with the reason. `command` is the `gh pr create`
// argv that was run, or with dryRun the one that would run; it is empty when no PR could be attempted at all
// (unreadable origin remote, or a repo that is not opted in).

import { parseRemote } from "../review/export.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs one command in the repo directory. Injected by tests; the default spawns a real process. */
export type Runner = (cmd: string[]) => Promise<RunResult>;

export interface OpenPrOptions {
  repoPath: string;
  branch: string;
  title: string;
  body: string;
  /** Build the command but never run gh. The owner/repo lookup still runs, because the opt-in check needs it. */
  dryRun?: boolean;
  /** Opt-in gate, called once with the origin remote's "owner/name". */
  allowRepo: (ownerRepo: string) => boolean;
  run?: Runner;
}

export interface OpenPrResult {
  opened: boolean;
  /** Only set when gh exited 0 and printed a URL. */
  url?: string;
  /** The `gh pr create` argv, whether or not it ran. Empty when there was nothing to attempt. */
  command: string[];
  reason?: string;
}

const NOT_OPTED_IN = "not opted in";
const DRY_RUN = "dry run";
/** Shell convention for "command not found"; gh missing from PATH reports this. */
const NOT_FOUND = 127;

/** A runner that spawns real processes in `cwd`. A missing binary (gh is not installed) is a failed command. */
function spawnRunner(cwd: string): Runner {
  return async (cmd) => {
    try {
      const proc = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr };
    } catch (err) {
      return { code: NOT_FOUND, stdout: "", stderr: message(err) };
    }
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The `gh pr create` argv for one request. The body is passed as the `--body-file` argument: the frozen F03
 * acceptance test pins this exact argv, so it is what runs (github's `--body-file` takes a path — noted in the
 * task summary, not silently changed here).
 */
export function prCreateCommand(o: { branch: string; title: string; body: string }): string[] {
  return ["gh", "pr", "create", "--head", o.branch, "--title", o.title, "--body-file", o.body];
}

/** The pull request URL in gh's stdout: the last URL token, so a leading "Warning:"/progress line is ignored. */
export function parsePrUrl(stdout: string): string | null {
  const found = stdout.match(/https?:\/\/[^\s<>"]+/g);
  const last = found?.at(-1);
  return last === undefined ? null : last.replace(/[.,;:)\]]+$/, "");
}

/**
 * Opens a PR for `branch` on `repoPath`'s origin, if that repo allows it. Reads "owner/name" from
 * `git remote get-url origin` (https, ssh:// and scp-style forms) and asks `allowRepo` first; a repo that is not
 * opted in never reaches gh. With `dryRun` the gh command is returned unrun.
 */
export async function openPr(opts: OpenPrOptions): Promise<OpenPrResult> {
  const run = opts.run ?? spawnRunner(opts.repoPath);

  let remote: RunResult;
  try {
    remote = await run(["git", "remote", "get-url", "origin"]);
  } catch (err) {
    return { opened: false, command: [], reason: `could not read the origin remote: ${message(err)}` };
  }
  if (remote.code !== 0) {
    return {
      opened: false,
      command: [],
      reason: remote.stderr.trim() || `git remote get-url origin exited ${remote.code}`,
    };
  }
  const ownerRepo = parseRemote(remote.stdout);
  if (ownerRepo === null) {
    return { opened: false, command: [], reason: `origin has no owner/name: ${remote.stdout.trim()}` };
  }

  if (!opts.allowRepo(ownerRepo)) return { opened: false, command: [], reason: NOT_OPTED_IN };

  const command = prCreateCommand(opts);
  if (opts.dryRun) return { opened: false, command, reason: DRY_RUN };

  let gh: RunResult;
  try {
    gh = await run(command);
  } catch (err) {
    return { opened: false, command, reason: message(err) };
  }
  if (gh.code !== 0) {
    return { opened: false, command, reason: gh.stderr.trim() || `gh pr create exited ${gh.code}` };
  }

  const url = parsePrUrl(gh.stdout);
  return url === null ? { opened: true, command } : { opened: true, url, command };
}
