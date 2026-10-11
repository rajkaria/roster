/**
 * MicroVM runner adapter (DESIGN §"Replay at the parent commit", §Security).
 *
 * Replays of public repos run in an isolated VM, never on the host. This module
 * owns only the run sequence — create, write, clone, exec, stop — and takes the
 * VM provider as an injected `MicroVmClient`, so the provider stays swappable
 * and the sequence is testable without booting a VM.
 */

/** One exec result as the VM client reports it. */
export interface MicroVmExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface MicroVmRunResult extends MicroVmExecResult {
  timedOut: boolean;
}

export interface MicroVmRunOptions {
  repoUrl: string;
  command: string[];
  timeoutMs: number;
  files?: Record<string, string>;
}

/** The VM provider. Convex on purpose: ids are opaque and every call may reject. */
export interface MicroVmClient {
  create(): Promise<{ id: string }>;
  exec(id: string, cmd: string[], timeoutMs: number): Promise<MicroVmExecResult>;
  write(id: string, path: string, content: string): Promise<void>;
  stop(id: string): Promise<void>;
}

const WORK_DIR = "/work";

/** The exit code GNU coreutils `timeout` uses; a client reports a timeout this way. */
const TIMEOUT_EXIT_CODE = 124;

/**
 * Only https is fetched inside the VM. A scp-style or ssh URL could carry a host
 * path or key material, and a plain-http one could be rewritten in transit.
 */
export function isHttpsRepoUrl(repoUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.hostname.length > 0;
}

/** One argv element as a shell word, so arguments with spaces or quotes survive. */
function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

/** The command as argv for a shell that is already in `WORK_DIR`. */
function commandInWorkDir(command: string[]): string[] {
  return ["/bin/sh", "-lc", `cd ${WORK_DIR} && exec ${command.map(shellQuote).join(" ")}`];
}

function toRunResult(r: MicroVmExecResult): MicroVmRunResult {
  return { code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.code === TIMEOUT_EXIT_CODE };
}

/** Stop after a failed run without masking the failure that is already being reported. */
async function stopIgnoringFailure(client: MicroVmClient, id: string): Promise<void> {
  try {
    await client.stop(id);
  } catch {
    // the run's own error is the one the caller needs
  }
}

async function runOnce(client: MicroVmClient, id: string, opts: MicroVmRunOptions): Promise<MicroVmRunResult> {
  for (const [path, content] of Object.entries(opts.files ?? {})) {
    await client.write(id, path, content);
  }
  const clone = await client.exec(
    id,
    ["git", "clone", "--filter=blob:none", opts.repoUrl, WORK_DIR],
    opts.timeoutMs,
  );
  // A failed or timed-out clone leaves no workspace to run in: report the clone's own result.
  if (clone.code !== 0) return toRunResult(clone);
  return toRunResult(await client.exec(id, commandInWorkDir(opts.command), opts.timeoutMs));
}

/**
 * Run `opts.command` against a clone of `opts.repoUrl` inside a fresh VM.
 *
 * The VM is stopped exactly once on every path that got as far as `create`,
 * including error and timeout paths: a leaked VM outlives the run that made it.
 */
export async function runInMicroVm(
  opts: MicroVmRunOptions,
  client: MicroVmClient,
): Promise<MicroVmRunResult> {
  if (!isHttpsRepoUrl(opts.repoUrl)) {
    throw new Error(`microVM repo URL must be https: ${JSON.stringify(opts.repoUrl)}`);
  }
  if (opts.command.length === 0) {
    throw new Error("microVM command is empty");
  }

  const { id } = await client.create();
  const outcome = await runOnce(client, id, opts).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  if (!outcome.ok) {
    await stopIgnoringFailure(client, id);
    throw outcome.error;
  }
  await client.stop(id);
  return outcome.value;
}
