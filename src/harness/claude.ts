// Claude Code headless adapter (DESIGN.md §"Harness adapters"). Seeded from src/replay/_spike/replay.ts.
//
//   const r = await runClaude({ sandboxPath, prompt, model, rulesFile, maxTurns, timeoutMs, budgetUsd })
//
// Steps: swap the rules file in and commit it as `setup:` -> run `claude -p` with a scrubbed env
// (retry only on 429/5xx) -> save the raw JSON per attempt -> save agent.patch against the setup commit.
// Never throws on agent failure.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitEnv } from "../sandbox/index.ts";
import type {
  HarnessAttempt,
  HarnessDiff,
  HarnessErrorKind,
  HarnessResult,
  HarnessRunOptions,
  HarnessTokens,
} from "./types.ts";

export const HARNESS = "claude-code";
export const RULES_NAME = "CLAUDE.md";
export const DEFAULT_ALLOWED_TOOLS = ["Edit", "Write", "Read", "Glob", "Grep", "Bash(bun test:*)", "Bash(bun test)"];
/** Tools that exist at all; anything else (Web*, Agent, MCP) is absent, not just denied. */
const TOOLS = "Bash,Edit,Write,Read,Glob,Grep";

// Host-session plumbing that would wire the child into the parent session.
const SCRUB =
  /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(SESSION_ID|HOST_SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|MESSAGING_.*|ENTRYPOINT|EMIT_TOOL_USE_SUMMARIES|REPORT_FINDINGS|TERMINAL_MCP_TOOLS|ENABLE_ASK_USER_QUESTION_TOOL|SDK_HAS_HOST_AUTH_REFRESH|ENABLE_SDK_FILE_CHECKPOINTING|DESKTOP_APP_VERSION)|CLAUDE_AGENT_SDK_.*|CLAUDE_EFFORT)$/;

export function childEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const merged = { ...process.env, ...extra };
  return Object.fromEntries(
    Object.entries(merged).filter((e): e is [string, string] => e[1] !== undefined && !SCRUB.test(e[0])),
  );
}

export function claudeArgs(o: HarnessRunOptions): string[] {
  return [
    "-p", o.prompt,
    "--model", o.model,
    "--output-format", "json",
    "--max-turns", String(o.maxTurns),
    "--permission-mode", "acceptEdits",
    "--permission-prompts", "none",
    "--allowedTools", (o.allowedTools ?? DEFAULT_ALLOWED_TOOLS).join(","),
    "--tools", TOOLS,
    "--setting-sources", "project",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--max-budget-usd", String(o.budgetUsd),
  ];
}

// ---------- git ----------
function git(cwd: string, args: string[]): { code: number | null; out: string; err: string } {
  const r = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: gitEnv(),
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
function gitOk(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err.trim()}`);
  return r.out;
}

/** Writes the setup's rules into the sandbox and commits it as `setup:`. Returns the setup commit. */
export function swapRules(sandboxPath: string, rulesFile: string | string[]): string {
  const files = Array.isArray(rulesFile) ? rulesFile : [rulesFile];
  const text = files.map((f) => readFileSync(f, "utf8")).join("\n");
  writeFileSync(join(sandboxPath, RULES_NAME), text);
  gitOk(sandboxPath, ["add", "-f", "--", RULES_NAME]);
  gitOk(sandboxPath, ["commit", "-q", "--allow-empty", "-m", `setup: ${RULES_NAME} from ${files.join(" + ")}`]);
  return gitOk(sandboxPath, ["rev-parse", "HEAD"]).trim();
}

/** Stages everything the agent did and writes `git diff --binary` against the setup commit. */
export function captureDiff(sandboxPath: string, setupSha: string, outDir: string): HarnessDiff {
  gitOk(sandboxPath, ["add", "-A"]);
  const patchPath = join(outDir, "agent.patch");
  writeFileSync(patchPath, gitOk(sandboxPath, ["diff", "--cached", "--binary", setupSha]));
  const rows = gitOk(sandboxPath, ["diff", "--cached", "--numstat", setupSha])
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t"));
  return {
    patchPath,
    filesChanged: rows.length,
    added: rows.reduce((s, r) => s + (Number(r[0]) || 0), 0),
    removed: rows.reduce((s, r) => s + (Number(r[1]) || 0), 0),
    files: rows.map((r) => r[2] ?? ""),
  };
}

/** Throws away a failed attempt's partial work so a retry starts from the setup commit. */
function resetTo(sandboxPath: string, setupSha: string): void {
  gitOk(sandboxPath, ["reset", "-q", "--hard", setupSha]);
  gitOk(sandboxPath, ["clean", "-qfdx"]);
}

// ---------- process ----------
interface Exec {
  code: number | null;
  out: string;
  err: string;
  timedOut: boolean;
  wallMs: number;
  spawnError: string | null;
}

/** Runs in its own process group so a timeout kills the agent's tool subprocesses too. */
function exec(bin: string, args: string[], cwd: string, env: Record<string, string>, timeoutMs: number): Promise<Exec> {
  const t0 = performance.now();
  return new Promise((done) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let spawnError: string | null = null;
    const p = spawn(bin, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const kill = () => {
      try {
        if (p.pid) process.kill(-p.pid, "SIGKILL");
      } catch {
        p.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    p.stdout?.on("data", (b: Buffer) => out.push(b));
    p.stderr?.on("data", (b: Buffer) => err.push(b));
    p.on("error", (e) => {
      spawnError = String(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) kill(); // stragglers that kept the pipes open
      done({
        code,
        out: Buffer.concat(out).toString(),
        err: Buffer.concat(err).toString(),
        timedOut,
        wallMs: Math.round(performance.now() - t0),
        spawnError,
      });
    });
  });
}

// ---------- parsing ----------
type Json = Record<string, any>;

export function parseResult(stdout: string): Json | null {
  const lines = stdout.trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i] ?? "");
      if (j && typeof j === "object" && !Array.isArray(j)) return j;
    } catch {}
  }
  try {
    const j = JSON.parse(stdout);
    return j && typeof j === "object" && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

/** HTTP status of an API failure, from the result text or stderr ("API Error: 529 ..."). */
export function apiStatusOf(j: Json | null, stderr: string): number | null {
  if (typeof j?.api_error_status === "number") return j.api_error_status;
  const text = `${typeof j?.result === "string" ? j.result : ""}\n${stderr}`;
  const m = text.match(/API Error:?\s*(\d{3})\b/i) ?? text.match(/\b(429|5\d\d)\b[^\n]*(rate.?limit|overloaded|server|unavailable|timeout)/i);
  return m ? Number(m[1]) : null;
}

const retryable = (s: number | null) => s !== null && (s === 429 || (s >= 500 && s <= 599));

function errorKindOf(j: Json | null, x: Exec, apiStatus: number | null): HarnessErrorKind | null {
  if (x.timedOut) return "timeout";
  if (x.spawnError) return "spawn_failed";
  if (!j) return "unparseable_output";
  const subtype = String(j.subtype ?? "");
  // Auth failures come back as subtype "success" with is_error true: trust is_error, not subtype.
  if (!j.is_error && subtype === "success") return null;
  if (subtype === "error_max_turns") return "max_turns";
  if (/budget/i.test(subtype)) return "budget";
  if (apiStatus === 429) return "rate_limited";
  if (retryable(apiStatus)) return "server_error";
  return "agent_error";
}

/** The model that did the work: the costliest `modelUsage` entry (background calls use cheaper ones). */
export function resolvedModel(j: Json | null): { model: string | null; models: string[] } {
  const mu: Json = j?.modelUsage ?? {};
  const models = Object.keys(mu);
  const weight = (k: string) => Number(mu[k]?.costUSD ?? 0) * 1e9 + Number(mu[k]?.outputTokens ?? 0);
  const model = models.length ? models.reduce((a, b) => (weight(b) > weight(a) ? b : a)) : null;
  return { model, models };
}

export function tokensOf(j: Json | null): HarnessTokens {
  const mu: Json | undefined = j?.modelUsage;
  if (mu && Object.keys(mu).length) {
    const sum = (k: string) => Object.values(mu).reduce((s: number, v: any) => s + (Number(v?.[k]) || 0), 0);
    return {
      input: sum("inputTokens"),
      output: sum("outputTokens"),
      cacheRead: sum("cacheReadInputTokens"),
      cacheWrite: sum("cacheCreationInputTokens"),
    };
  }
  const u: Json = j?.usage ?? {};
  return {
    input: Number(u.input_tokens) || 0,
    output: Number(u.output_tokens) || 0,
    cacheRead: Number(u.cache_read_input_tokens) || 0,
    cacheWrite: Number(u.cache_creation_input_tokens) || 0,
  };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- entry ----------
export async function runClaude(o: HarnessRunOptions): Promise<HarnessResult> {
  const sandboxPath = resolve(o.sandboxPath);
  const outDir = resolve(o.outDir ?? `${sandboxPath}.out`);
  const args = claudeArgs(o);
  const bin = o.bin ?? "claude";
  const res: HarnessResult = {
    harness: HARNESS, sessionId: null, model: null, models: [], turns: null, durationMs: null, costUsd: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, isError: true, errorKind: null, stopReason: null,
    transcriptPath: null, diff: null, setupSha: null, attempts: [], command: [bin, ...args],
  };

  try {
    mkdirSync(outDir, { recursive: true });
    res.setupSha = swapRules(sandboxPath, o.rulesFile);
  } catch (e) {
    res.errorKind = "setup_failed";
    writeFileSync(join(outDir, "error.txt"), String(e));
    return res;
  }

  const env = childEnv(o.env);
  const maxRetries = o.maxRetries ?? 2;
  let last: Json | null = null;
  const setupSha = res.setupSha;
  for (let n = 1; ; n++) {
    if (n > 1) {
      try {
        resetTo(sandboxPath, setupSha);
      } catch (e) {
        writeFileSync(join(outDir, "error.txt"), String(e));
        break; // keep the last attempt's verdict rather than run on a dirty sandbox
      }
    }
    const x = await exec(bin, args, sandboxPath, env, o.timeoutMs);
    const j = parseResult(x.out);
    const apiStatus = x.timedOut ? null : apiStatusOf(j, x.err);
    const errorKind = errorKindOf(j, x, apiStatus);
    const rawPath = join(outDir, `claude.attempt-${n}.json`);
    writeFileSync(rawPath, j ? JSON.stringify(j, null, 2) : JSON.stringify({ stdout: x.out, stderr: x.err.slice(-4000), spawnError: x.spawnError }, null, 2));
    const costUsd = num(j?.total_cost_usd);
    res.attempts.push({ n, exitCode: x.code, timedOut: x.timedOut, wallMs: x.wallMs, isError: errorKind !== null, errorKind, apiStatus, rawPath, costUsd });
    if (costUsd !== null) res.costUsd = (res.costUsd ?? 0) + costUsd;
    const t = tokensOf(j);
    res.tokens = { input: res.tokens.input + t.input, output: res.tokens.output + t.output, cacheRead: res.tokens.cacheRead + t.cacheRead, cacheWrite: res.tokens.cacheWrite + t.cacheWrite };
    last = j;
    res.isError = errorKind !== null;
    res.errorKind = errorKind;
    res.transcriptPath = rawPath;
    if (!(errorKind !== null && retryable(apiStatus) && n <= maxRetries)) break;
    await sleep((o.retryBaseMs ?? 2000) * 2 ** (n - 1));
  }

  const { model, models } = resolvedModel(last);
  res.model = model;
  res.models = models;
  res.sessionId = typeof last?.session_id === "string" ? last.session_id : null;
  res.turns = num(last?.num_turns);
  res.durationMs = num(last?.duration_ms) ?? res.attempts.at(-1)?.wallMs ?? null;
  res.stopReason = last?.terminal_reason ?? last?.stop_reason ?? null;
  writeFileSync(join(outDir, "claude.json"), readFileSync(res.transcriptPath!, "utf8"));
  res.transcriptPath = join(outDir, "claude.json");

  // Partial work is still evidence: capture the diff even when the agent errored.
  try {
    res.diff = captureDiff(sandboxPath, res.setupSha, outDir);
  } catch (e) {
    writeFileSync(join(outDir, "error.txt"), String(e));
    if (!res.isError) {
      res.isError = true;
      res.errorKind = "setup_failed";
    }
  }
  return res;
}
