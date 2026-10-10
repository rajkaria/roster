// Replay runner (DESIGN.md §"Replay at the parent commit", §"Grade"): for each (task, setup), a sandbox at the
// task's parent commit, the setup's rules, the harness, a grade in a separate copy, failure codes, one Replay row.
//
//   const replays = await runReplays({ repo, tasks, setups, workRoot, maxCostUsd: 5 });
//
// Never throws for one run going wrong: a harness error is a Replay with verdict agent_error. Runs that are not
// started (unavailable candidate, budget reached, unsupported harness) are reported through `onSkip`.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, posix, resolve, sep } from "node:path";
import { runClaude } from "../harness/claude.ts";
import type { HarnessResult } from "../harness/types.ts";
import { grade, isTestFile, type GradeResult } from "../grade/index.ts";
import { classify, parseTranscript, type Transcript } from "../grade/taxonomy.ts";
import { createSandbox, destroySandbox, proveIsolation, runGit, type IsolationProof } from "../sandbox/index.ts";
import type { RunnableSetup } from "../setups/registry.ts";
import { FailureCode, type Replay, type ReplayVerdict } from "../types.ts";
import type { ReplayTask } from "./tasks.ts";

export interface SkippedRun {
  task: string;
  setup: string;
  reason: string;
}

export interface RunReplaysOptions {
  /** Local path of the repo the tasks come from. */
  repo: string;
  tasks: ReplayTask[];
  setups: RunnableSetup[];
  /** Sandboxes go here. Must not be under $HOME. */
  workRoot: string;
  /** Concurrent runs. Default 3. */
  parallel?: number;
  /** No new run starts once the summed cost of finished runs reaches this. */
  maxCostUsd: number;
  harness?: typeof runClaude;
  planId?: string;
  attempt?: number;
  /** Spend cap per harness run, also bounded by what is left of maxCostUsd. Default 2. */
  perRunUsd?: number;
  maxTurns?: number;
  timeoutMs?: number;
  /** Test command for grading; default: detected from the sandbox. */
  testCmd?: string;
  /** The real `claude` binary the setting-sources shim execs. Default "claude" on the child's PATH. */
  claudeBin?: string;
  keepSandboxes?: boolean;
  onSkip?: (s: SkippedRun) => void;
}

const DEFAULT_PARALLEL = 3;
const DEFAULT_PER_RUN_USD = 2;
const DEFAULT_MAX_TURNS = 30;
const DEFAULT_TIMEOUT_MS = 20 * 60_000;
export const LOCAL_RULES_NAME = "CLAUDE.local.md";
export const SETTING_SOURCES = "project,local";

/** Default work root: the OS temp dir, never $HOME. */
export function defaultWorkRoot(): string {
  return join(tmpdir(), "roster-replays");
}

function underHome(path: string): boolean {
  const home = resolve(homedir());
  const p = resolve(path);
  return p === home || p.startsWith(home + sep);
}

/**
 * The harness pins `--setting-sources project`; replays also load CLAUDE.local.md, which needs `local`.
 * This shim rewrites that one value and execs the real binary.
 */
export function writeSettingSourcesShim(dir: string, target = "claude"): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude-setting-sources");
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  writeFileSync(
    path,
    `#!/bin/bash
# Written by src/replay/run.ts: --setting-sources project -> ${SETTING_SOURCES}
args=(); prev=""
for a in "$@"; do
  if [ "$prev" = "--setting-sources" ] && [ "$a" = "project" ]; then a=${q(SETTING_SOURCES)}; fi
  args+=("$a"); prev="$a"
done
exec ${q(target)} "\${args[@]}"
`,
  );
  chmodSync(path, 0o755);
  return path;
}

/** Why a setup cannot run, or null when it can. */
function unavailable(setup: RunnableSetup): string | null {
  if (setup.candidate && Object.keys(setup.env).length === 0) return "unavailable";
  if (setup.harness !== "claude-code") return `unsupported harness ${setup.harness}`;
  return null;
}

/** Directories the original change touched, for the scope guard. */
function touchedDirs(repo: string, task: ReplayTask): string[] | undefined {
  try {
    const files = runGit(repo, ["diff", "--name-only", task.parentSha, task.originalSha]).split("\n").filter(Boolean);
    return [...new Set(files.map((f) => posix.dirname(f)))];
  } catch {
    return undefined;
  }
}

/**
 * The harness writes `--output-format json` (one result object), not stream-json. Both parse here; a result-only
 * transcript has no tool calls, so it carries no evidence for F2.
 */
function loadTranscript(path: string | null): { t: Transcript; hasCalls: boolean } {
  let text = "";
  try {
    if (path && existsSync(path)) text = readFileSync(path, "utf8");
  } catch {}
  let t = parseTranscript(text);
  if (t.turns === 0 && t.result === null && text.trim()) {
    try {
      const j = JSON.parse(text);
      t = parseTranscript((Array.isArray(j) ? j : [j]).map((e) => JSON.stringify(e)).join("\n"));
    } catch {}
  }
  return { t, hasCalls: t.turns > 0 };
}

function verdictOf(g: GradeResult, hasHidden: boolean): ReplayVerdict {
  if (hasHidden && !g.hiddenPass) return "hidden_tests_failed";
  if (!g.suitePass) return "suite_failed";
  if (!g.scopeOk) return "guardrail_flagged";
  return "pass";
}

const ERROR_CODE: Partial<Record<string, FailureCode>> = {
  timeout: FailureCode.F5,
  max_turns: FailureCode.F5,
  budget: FailureCode.F5,
  spawn_failed: FailureCode.F6,
  setup_failed: FailureCode.F6,
};

/** One (task, setup) run. Never throws. */
async function runOne(
  o: RunReplaysOptions & { harness: typeof runClaude; bin: string },
  task: ReplayTask,
  setup: RunnableSetup,
  budgetUsd: number,
): Promise<Replay> {
  const attempt = o.attempt ?? 1;
  const planId = o.planId ?? "adhoc";
  const row: Replay = {
    id: `${planId}:${task.id}:${setup.id}:${attempt}`,
    plan_id: planId,
    task_session_id: task.id,
    setup_id: setup.id,
    attempt,
    isolation_proof: "",
    turns: null,
    duration_ms: null,
    cost_usd: null,
    hidden_pass: null,
    suite_pass: null,
    scope_ok: null,
    judge_equiv: null,
    failure_codes: [],
    verdict: "agent_error",
    transcript_ref: null,
    trace_url: null,
  };
  const fail = (code: FailureCode, why: string): Replay => {
    row.failure_codes = [code];
    if (!row.isolation_proof) row.isolation_proof = JSON.stringify({ ok: false, checks: [], error: why });
    return row;
  };

  let sandboxPath: string | null = null;
  try {
    const sb = await createSandbox(o.repo, task.parentSha, { root: o.workRoot });
    sandboxPath = sb.path;
    const proof: IsolationProof = await proveIsolation(sb.path, o.repo, task.parentSha);
    row.isolation_proof = JSON.stringify(proof);
    if (!proof.ok) return fail(FailureCode.F6, "isolation proof failed");

    // Rules in, committed as `setup:` so neither the agent's diff nor the grade sees them.
    writeFileSync(join(sb.path, "CLAUDE.md"), readFileSync(setup.rulesPath, "utf8"));
    const ruleFiles = ["CLAUDE.md"];
    if (setup.extraRulesPath) {
      writeFileSync(join(sb.path, LOCAL_RULES_NAME), readFileSync(setup.extraRulesPath, "utf8"));
      ruleFiles.push(LOCAL_RULES_NAME);
    }
    runGit(sb.path, ["add", "-f", "--", ...ruleFiles]);
    runGit(sb.path, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", `setup: ${ruleFiles.join(" + ")} for ${setup.id}`]);
    const rulesSha = runGit(sb.path, ["rev-parse", "HEAD"]);

    let res: HarnessResult | null = null;
    let harnessError: string | null = null;
    try {
      res = await o.harness({
        sandboxPath: sb.path,
        prompt: task.prompt,
        model: setup.model,
        rulesFile: setup.rulesPath,
        maxTurns: o.maxTurns ?? DEFAULT_MAX_TURNS,
        timeoutMs: o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        budgetUsd,
        env: setup.env,
        bin: o.bin,
      });
    } catch (e) {
      harnessError = e instanceof Error ? e.message : String(e);
    }
    if (!res) return fail(FailureCode.F6, `harness threw: ${harnessError}`);

    row.turns = res.turns;
    row.duration_ms = res.durationMs;
    row.cost_usd = res.costUsd;
    row.transcript_ref = res.transcriptPath;
    const { t, hasCalls } = loadTranscript(res.transcriptPath);

    if (res.isError) {
      const codes = new Set(classify({ verdict: "agent_error" }, null, t).map((c) => c.code));
      const forced = res.errorKind ? ERROR_CODE[res.errorKind] : undefined;
      if (forced === FailureCode.F6) codes.clear();
      if (forced) codes.add(forced);
      if (!hasCalls) codes.delete(FailureCode.F2);
      // A result-only transcript of an errored run is not a kill: drop the "no result event" F5 unless forced.
      if (t.result === null && forced !== FailureCode.F5 && !hasCalls) codes.delete(FailureCode.F5);
      row.failure_codes = Object.values(FailureCode).filter((c) => codes.has(c));
      return row;
    }

    // The agent's base is the setup commit (the harness's own when it made one).
    const base = res.setupSha ?? rulesSha;
    runGit(sb.path, ["add", "-A"]);
    const changed = runGit(sb.path, ["diff", "--cached", "--name-only", base]).split("\n").filter(Boolean);
    let g: GradeResult | null = null;
    if (changed.length === 0) row.verdict = "no_changes";
    else {
      const preexistingTests = runGit(sb.path, ["ls-tree", "-r", "--name-only", base]).split("\n").filter(isTestFile);
      g = await grade({
        sandbox: { path: sb.path, baseSha: base },
        hidden: task.hiddenTests,
        testCmd: o.testCmd,
        preexistingTests,
        touchedDirs: touchedDirs(o.repo, task),
      });
      const hasHidden = task.hiddenTests.length > 0;
      row.hidden_pass = hasHidden ? g.hiddenPass : null;
      row.suite_pass = g.suitePass;
      row.scope_ok = g.scopeOk;
      row.verdict = verdictOf(g, hasHidden);
    }
    // The run finished without error, so a missing result event is not a kill.
    const result = t.result ?? { subtype: "success", isError: false, numTurns: res.turns, terminalReason: res.stopReason };
    const codes = classify({ verdict: row.verdict }, g, { ...t, result }).map((c) => c.code);
    row.failure_codes = hasCalls ? codes : codes.filter((c) => c !== FailureCode.F2);
    return row;
  } catch (e) {
    // Sandbox, rules or grading broke: the environment, not the agent.
    row.verdict = "agent_error";
    row.hidden_pass = row.suite_pass = row.scope_ok = null;
    return fail(FailureCode.F6, e instanceof Error ? e.message : String(e));
  } finally {
    if (sandboxPath && !o.keepSandboxes) await destroySandbox(sandboxPath);
  }
}

export async function runReplays(opts: RunReplaysOptions): Promise<Replay[]> {
  const workRoot = resolve(opts.workRoot);
  if (underHome(workRoot)) throw new Error(`workRoot ${workRoot} is under $HOME; replays must run outside it`);
  mkdirSync(workRoot, { recursive: true });
  const bin = writeSettingSourcesShim(join(workRoot, "bin"), opts.claudeBin);
  const o = { ...opts, workRoot, harness: opts.harness ?? runClaude, bin };
  const skip = (task: string, setup: string, reason: string) => opts.onSkip?.({ task, setup, reason });

  const queue: Array<{ task: ReplayTask; setup: RunnableSetup; order: number }> = [];
  for (const task of opts.tasks) {
    for (const setup of opts.setups) {
      const why = unavailable(setup);
      if (why) skip(task.id, setup.id, why);
      else queue.push({ task, setup, order: queue.length });
    }
  }

  const out: Array<{ order: number; replay: Replay }> = [];
  let spent = 0;
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const job = queue[next++]!;
      const left = opts.maxCostUsd - spent;
      if (left <= 0) {
        skip(job.task.id, job.setup.id, `budget: spent $${spent.toFixed(4)} of $${opts.maxCostUsd}`);
        continue;
      }
      const replay = await runOne(o, job.task, job.setup, Math.min(opts.perRunUsd ?? DEFAULT_PER_RUN_USD, left));
      spent += replay.cost_usd ?? 0;
      out.push({ order: job.order, replay });
    }
  };
  const n = Math.max(1, Math.floor(opts.parallel ?? DEFAULT_PARALLEL));
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, worker));
  return out.sort((a, b) => a.order - b.order).map((x) => x.replay);
}
