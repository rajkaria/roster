// One contract for every harness adapter (DESIGN.md §"Replay at the parent commit", "Harness adapters").
// An adapter runs one replay task in a prepared sandbox and returns what grading and pricing need.
// Adapters never throw on agent failure: failures come back as isError + errorKind.

export interface HarnessRunOptions {
  /** Sandbox repo built by src/sandbox (one base commit, no remotes). */
  sandboxPath: string;
  /** The task, as the user originally gave it. */
  prompt: string;
  /** Requested model flag. The result records the model the run actually resolved. */
  model: string;
  /** Setup rules file(s). Several paths are concatenated in order (base rules + appended rules). */
  rulesFile: string | string[];
  maxTurns: number;
  /** Wall-clock cap per attempt. The process group is killed when it runs out. */
  timeoutMs: number;
  /** Hard spend cap per attempt. */
  budgetUsd: number;
  /** Extra env for the child. Host-session variables are scrubbed after merging. */
  env?: Record<string, string | undefined>;
  /** Where agent.patch and the raw JSON go. Must be outside the sandbox. Default: `<sandboxPath>.out`. */
  outDir?: string;
  /** Tool allowlist. Default: the adapter's own. */
  allowedTools?: string[];
  /** Binary to run. Default: the harness name, resolved on the child's PATH. */
  bin?: string;
  /** Retries on 429/5xx only. Default 2. */
  maxRetries?: number;
  /** First backoff delay; doubles per retry. Default 2000. */
  retryBaseMs?: number;
}

export type HarnessErrorKind =
  | "timeout" // wall-clock cap hit, process killed
  | "max_turns" // turn cap hit
  | "budget" // spend cap hit
  | "rate_limited" // 429, retries exhausted
  | "server_error" // 5xx, retries exhausted
  | "provider_unavailable" // billing, auth or availability error from the provider (401/402/403, "Insufficient Balance", ...)
  | "agent_error" // the harness reported is_error for another reason (auth, refusal, ...)
  | "unparseable_output" // exited without a result JSON
  | "spawn_failed" // binary missing or not executable
  | "setup_failed"; // rules swap or diff capture failed

export interface HarnessTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface HarnessDiff {
  /** `git diff --binary` of the agent's work against the `setup:` commit. */
  patchPath: string;
  filesChanged: number;
  added: number;
  removed: number;
  files: string[];
}

export interface HarnessAttempt {
  /** 1-based. */
  n: number;
  exitCode: number | null;
  timedOut: boolean;
  wallMs: number;
  isError: boolean;
  errorKind: HarnessErrorKind | null;
  /** HTTP status when the failure was an API error, else null. */
  apiStatus: number | null;
  /** Raw output of this attempt. */
  rawPath: string;
  costUsd: number | null;
}

export interface HarnessResult {
  harness: string;
  sessionId: string | null;
  /** Resolved model (the costliest entry of `modelUsage`), never the requested flag. Null when unknown. */
  model: string | null;
  /** Every model the run used, as reported. */
  models: string[];
  turns: number | null;
  durationMs: number | null;
  /** Cost the harness reported, summed over attempts. Null when no attempt reported one. */
  costUsd: number | null;
  tokens: HarnessTokens;
  isError: boolean;
  errorKind: HarnessErrorKind | null;
  stopReason: string | null;
  /** Raw JSON of the final attempt. */
  transcriptPath: string | null;
  diff: HarnessDiff | null;
  /** Commit holding the swapped rules file; the agent diff is taken against it. */
  setupSha: string | null;
  attempts: HarnessAttempt[];
  /** The argv of the final attempt (prompt included). */
  command: string[];
}
