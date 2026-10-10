// replay.ts — replay a past coding-agent task at its parent commit under a candidate "setup",
// then grade it with the hidden acceptance tests. Spike code (bun), seeds the real implementation.
//
//   const r = await replayTask(task, setup, { workRoot, timeoutMs })
//
// Steps: buildSandbox -> proveIsolation -> applySetup -> runAgent -> grade -> verdict.
// Never throws for agent/grader failures: every failure becomes a ReplayResult with ok=false + reason.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

// ---------- types ----------
export type HarnessId = "claude-code" | "codex";

export interface Setup {
  id: string;                 // "A-haiku-permissive"
  harness: HarnessId;
  model: string;              // "haiku" | "claude-haiku-5-5" | "gpt-5-codex" ...
  rules: string;              // contents of CLAUDE.md / AGENTS.md swapped into the sandbox
  maxTurns: number;
  maxBudgetUsd?: number;      // hard spend cap per replay (claude: --max-budget-usd)
  extraArgs?: string[];
}

export interface ReplayTask {
  id: string;
  repoPath: string;           // source repo (has full history incl. the future)
  parentSha: string;          // commit the original agent started from
  originalSha: string;        // the original change (used ONLY by the grader + isolation proof)
  prompt: string;             // natural-language task, as the user gave it
  hiddenTests: string[];      // repo-relative test files taken from originalSha
  testCmd: string[];          // e.g. ["bun","test"]
  testGlob: RegExp;           // what counts as a test file, for "modified existing tests"
}

export interface AgentMetrics {
  sessionId?: string; model?: string; numTurns?: number; durationMs?: number; durationApiMs?: number;
  costUsd?: number; isError: boolean; subtype?: string; stopReason?: string; resultText?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  modelUsage?: Record<string, unknown>; permissionDenials?: unknown[];
  exitCode: number | null; timedOut: boolean; wallMs: number; stderrTail: string; rawJson?: unknown;
}

export interface TestCase { file: string; name: string; passed: boolean; message?: string }
export interface Grade {
  agentSuite: { passed: boolean; exitCode: number | null };      // agent's own tests, before overlay
  hidden: { passed: boolean; cases: TestCase[] };                 // hidden acceptance tests only
  fullSuite: { passed: boolean; exitCode: number | null; cases: TestCase[] };
  diff: { filesChanged: number; added: number; removed: number; files: string[] };
  modifiedExistingTests: string[];
  patchPath: string;
}

export interface IsolationProof {
  ok: boolean; refs: string[]; reflogEntries: number; commitsReachable: number; remotes: string[];
  futureObjectsChecked: number; futureObjectsPresent: string[]; looseAndPacked: string;
}

export interface ReplayResult {
  taskId: string; setupId: string; ws: string;
  ok: boolean;                                // promoted-eligible outcome
  reason: string;                             // "pass" | "agent_error: ..." | "hidden_tests_failed: ..." | ...
  isolation?: IsolationProof; agent?: AgentMetrics; grade?: Grade; command?: string[];
}

// ---------- process helper ----------
function sh(cmd: string[], cwd: string, opts: { timeoutMs?: number; env?: Record<string, string | undefined>; stdin?: string } = {}) {
  const t0 = performance.now();
  const p = Bun.spawnSync(cmd, {
    cwd, env: opts.env ?? (process.env as Record<string, string>), timeout: opts.timeoutMs,
    stdin: opts.stdin !== undefined ? Buffer.from(opts.stdin) : "ignore", stdout: "pipe", stderr: "pipe",
  });
  return {
    code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString(),
    timedOut: p.signalCode === "SIGTERM" && p.exitCode === null, ms: Math.round(performance.now() - t0),
  };
}
const git = (cwd: string, ...a: string[]) => sh(["git", "-c", "core.hooksPath=/dev/null", ...a], cwd);

// ---------- 1. sandbox ----------
/** Snapshot-only sandbox: tree of parentSha, brand-new repo with ONE commit, no remote, no reflog of the source. */
export function buildSandbox(repoPath: string, sha: string, ws: string): void {
  if (existsSync(ws)) throw new Error(`sandbox exists: ${ws}`);
  mkdirSync(ws, { recursive: true });
  const tar = join(dirname(ws), `${sha.slice(0, 12)}.tar`);
  const a = git(repoPath, "archive", "--format=tar", "-o", tar, sha);
  if (a.code !== 0) throw new Error(`git archive failed: ${a.err}`);
  sh(["tar", "-xf", tar, "-C", ws], ws);
  for (const c of [["init", "-q", "-b", "main"], ["add", "-A"],
    ["-c", "user.name=replay", "-c", "user.email=replay@sandbox.invalid", "commit", "-qm", `base: snapshot of ${sha.slice(0, 12)}`]])
    git(ws, ...c);
}

/** Alternative that keeps PAST history: bundle only what is reachable from parentSha. */
export function buildSandboxWithHistory(repoPath: string, sha: string, ws: string): void {
  const ref = `refs/heads/replay-base-${sha.slice(0, 12)}`;
  git(repoPath, "update-ref", ref, sha);
  const bundle = join(dirname(ws), `${sha.slice(0, 12)}.bundle`);
  const b = git(repoPath, "bundle", "create", bundle, ref);
  git(repoPath, "update-ref", "-d", ref);
  if (b.code !== 0) throw new Error(`bundle failed: ${b.err}`);
  const c = sh(["git", "clone", "-q", "--no-hardlinks", "-b", ref.replace("refs/heads/", ""), bundle, ws], dirname(ws));
  if (c.code !== 0) throw new Error(`clone failed: ${c.err}`);
  git(ws, "remote", "remove", "origin");
  git(ws, "reflog", "expire", "--expire=now", "--all");
}

/** Proof that nothing introduced after parentSha exists in the sandbox's object DB, refs, reflog or remotes. */
export function proveIsolation(repoPath: string, parentSha: string, ws: string): IsolationProof {
  // objects reachable from any ref in the source repo but NOT from parentSha = "the future"
  const future = git(repoPath, "rev-list", "--objects", "--all", `^${parentSha}`).out
    .split("\n").filter(Boolean).map((l) => l.split(" ")[0]);
  const present = future.filter((o) => git(ws, "cat-file", "-e", o).code === 0);
  const refs = git(ws, "for-each-ref", "--format=%(refname)").out.split("\n").filter(Boolean);
  const reflog = git(ws, "reflog", "--all").out.split("\n").filter(Boolean).length;
  const commits = Number(git(ws, "rev-list", "--all", "--count").out.trim());
  const remotes = git(ws, "remote").out.split("\n").filter(Boolean);
  const counts = git(ws, "count-objects", "-v").out.replace(/\n/g, " ").trim();
  return { ok: present.length === 0 && remotes.length === 0, refs, reflogEntries: reflog, commitsReachable: commits,
    remotes, futureObjectsChecked: future.length, futureObjectsPresent: present, looseAndPacked: counts };
}

// ---------- 2. setup swap ----------
export const RULES_FILE: Record<HarnessId, string> = { "claude-code": "CLAUDE.md", codex: "AGENTS.md" };
export function applySetup(ws: string, setup: Setup): void {
  writeFileSync(join(ws, RULES_FILE[setup.harness]), setup.rules);
  git(ws, "add", "-A");
  git(ws, "-c", "user.name=replay", "-c", "user.email=replay@sandbox.invalid", "commit", "-qm", `setup: ${setup.id}`);
}

// ---------- 3. agent adapters ----------
export function claudeCommand(setup: Setup, prompt: string): string[] {
  return ["claude", "-p", prompt,
    "--model", setup.model,
    "--output-format", "json",
    "--max-turns", String(setup.maxTurns),
    "--permission-mode", "acceptEdits",                       // edits auto-approved, inside cwd only
    "--allowedTools", "Edit,Write,Read,Glob,Grep,Bash(bun test:*),Bash(bun test)",
    "--tools", "Bash,Edit,Write,Read,Glob,Grep",              // nothing else exists (no Web*, no Agent)
    "--permission-prompts", "none",                          // anything that would prompt is denied, never hangs
    "--setting-sources", "project",                          // ignore ~/.claude settings, hooks, plugins
    "--strict-mcp-config",                                   // no MCP servers
    "--disable-slash-commands",                              // no user skills
    "--no-session-persistence",
    ...(setup.maxBudgetUsd ? ["--max-budget-usd", String(setup.maxBudgetUsd)] : []),
    ...(setup.extraArgs ?? [])];
}

/** Codex CLI as a 3rd harness (not installed here; shape only). Emits JSONL events; usage on turn.completed, no USD. */
export function codexCommand(setup: Setup, prompt: string, ws: string): string[] {
  return ["codex", "exec", "--json", "--model", setup.model, "--sandbox", "workspace-write",
    "-c", "approval_policy=never", "--skip-git-repo-check", "-C", ws, prompt];
}

/** Env for the child: strip host-session plumbing so the replay is not wired into the parent session. */
export function childEnv(): Record<string, string> {
  const drop = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(SESSION_ID|HOST_SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|MESSAGING_.*|ENTRYPOINT|EMIT_TOOL_USE_SUMMARIES|REPORT_FINDINGS|TERMINAL_MCP_TOOLS|ENABLE_ASK_USER_QUESTION_TOOL|SDK_HAS_HOST_AUTH_REFRESH|ENABLE_SDK_FILE_CHECKPOINTING|DESKTOP_APP_VERSION)|CLAUDE_AGENT_SDK_.*|CLAUDE_EFFORT)$/;
  return Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !drop.test(k))) as Record<string, string>;
}

export function parseClaudeJson(stdout: string, stderr: string, code: number | null, timedOut: boolean, wallMs: number): AgentMetrics {
  const base = { exitCode: code, timedOut, wallMs, stderrTail: stderr.slice(-400) };
  let j: any;
  try { j = JSON.parse(stdout.trim().split("\n").filter(Boolean).at(-1) ?? ""); }
  catch { return { ...base, isError: true, subtype: timedOut ? "timeout" : "unparseable_output", resultText: stdout.slice(0, 300) }; }
  const u = j.usage ?? {};
  return { ...base, rawJson: j, sessionId: j.session_id, numTurns: j.num_turns, durationMs: j.duration_ms,
    durationApiMs: j.duration_api_ms, costUsd: j.total_cost_usd, subtype: j.subtype, stopReason: j.terminal_reason ?? j.stop_reason,
    // NOTE: auth failures come back as subtype "success" + is_error true -> always trust is_error, not subtype
    isError: Boolean(j.is_error) || j.subtype !== "success" || timedOut,
    resultText: typeof j.result === "string" ? j.result.slice(0, 500) : undefined,
    model: Object.keys(j.modelUsage ?? {}).join(",") || undefined, modelUsage: j.modelUsage,
    permissionDenials: j.permission_denials,
    usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 } };
}

export function runAgent(ws: string, setup: Setup, prompt: string, timeoutMs: number): { cmd: string[]; m: AgentMetrics } {
  if (setup.harness !== "claude-code") {
    const cmd = codexCommand(setup, prompt, ws);
    return { cmd, m: { isError: true, subtype: "harness_not_installed", exitCode: null, timedOut: false, wallMs: 0, stderrTail: "" } };
  }
  const cmd = claudeCommand(setup, prompt);
  let r: ReturnType<typeof sh>;
  try { r = sh(cmd, ws, { timeoutMs, env: childEnv() }); }
  catch (e) { return { cmd, m: { isError: true, subtype: "spawn_failed", resultText: String(e), exitCode: null, timedOut: false, wallMs: 0, stderrTail: "" } }; }
  return { cmd, m: parseClaudeJson(r.out, r.err, r.code, r.timedOut, r.ms) };
}

// ---------- 4. grading ----------
function parseJunit(xml: string): TestCase[] {
  const cases: TestCase[] = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of xml.matchAll(re)) {
    const attr = (k: string) => (m[1].match(new RegExp(`\\b${k}="([^"]*)"`)) ?? [])[1] ?? "";
    const body = m[3] ?? "";
    const fail = /<(failure|error)\b/.test(body);
    const skipped = /<skipped\b/.test(body);
    cases.push({ file: attr("file"), name: attr("name"), passed: !fail && !skipped,
      message: fail ? (body.match(/message="([^"]*)"/) ?? [])[1]?.slice(0, 200) : skipped ? "skipped" : undefined });
  }
  return cases;
}

export function grade(task: ReplayTask, ws: string, outDir: string): Grade {
  mkdirSync(outDir, { recursive: true });
  // a) agent's own suite, before the grader touches anything
  const own = sh(task.testCmd, ws, { timeoutMs: 120_000 });
  // b) diff of agent work vs the setup commit (rules file excluded, it's committed in "setup")
  git(ws, "add", "-A");
  const numstat = git(ws, "diff", "--cached", "--numstat", "HEAD").out.split("\n").filter(Boolean)
    .map((l) => { const [a, r, f] = l.split("\t"); return { a: Number(a) || 0, r: Number(r) || 0, f }; });
  const status = git(ws, "diff", "--cached", "--name-status", "HEAD").out.split("\n").filter(Boolean)
    .map((l) => l.split("\t"));
  const modifiedExistingTests = status.filter(([s, f]) => (s === "M" || s === "D" || s.startsWith("R")) && task.testGlob.test(f)).map(([, f]) => f);
  const patchPath = join(outDir, "agent.patch");
  writeFileSync(patchPath, git(ws, "diff", "--cached", "--binary", "HEAD").out);
  // c) overlay hidden tests from the ORIGINAL commit (SWE-bench style: overwrite at original path)
  for (const f of task.hiddenTests) {
    const content = git(task.repoPath, "show", `${task.originalSha}:${f}`).out;
    mkdirSync(dirname(join(ws, f)), { recursive: true });
    writeFileSync(join(ws, f), content);
  }
  // d) full suite with per-test results (junit written OUTSIDE the sandbox)
  const junit = join(outDir, "junit.xml");
  const full = sh([...task.testCmd, "--reporter=junit", `--reporter-outfile=${junit}`], ws, { timeoutMs: 120_000 });
  const cases = existsSync(junit) ? parseJunit(readFileSync(junit, "utf8")) : [];
  // bun's junit silently OMITS files that fail to load (e.g. missing export) -> synthesize a failing case
  for (const f of task.hiddenTests)
    if (!cases.some((c) => c.file === f))
      cases.push({ file: f, name: `${f} (0 tests collected: load error)`, passed: false,
        message: (full.err.split("\n").find((l) => /error|SyntaxError|not found|Export named/i.test(l)) ?? "").slice(0, 200) });
  const hiddenCases = cases.filter((c) => task.hiddenTests.includes(c.file));
  return {
    agentSuite: { passed: own.code === 0, exitCode: own.code },
    hidden: { passed: hiddenCases.length > 0 && hiddenCases.every((c) => c.passed), cases: hiddenCases },
    fullSuite: { passed: full.code === 0 && cases.every((c) => c.passed), exitCode: full.code, cases },
    diff: { filesChanged: numstat.length, added: numstat.reduce((s, x) => s + x.a, 0), removed: numstat.reduce((s, x) => s + x.r, 0), files: numstat.map((x) => x.f) },
    modifiedExistingTests, patchPath,
  };
}

export function verdict(agent: AgentMetrics | undefined, g: Grade | undefined): { ok: boolean; reason: string } {
  if (agent?.isError) return { ok: false, reason: `agent_error: ${agent.timedOut ? "timeout" : `${agent.subtype}/${agent.stopReason}`}${agent.resultText ? ` — ${agent.resultText.slice(0, 160)}` : ""}` };
  if (!g) return { ok: false, reason: "not_graded" };
  if (g.diff.filesChanged === 0) return { ok: false, reason: "no_changes" };
  if (!g.hidden.passed) return { ok: false, reason: `hidden_tests_failed: ${g.hidden.cases.filter((c) => !c.passed).map((c) => c.name).join("; ") || "no hidden tests ran"}` };
  if (!g.fullSuite.passed) return { ok: false, reason: `suite_failed: ${g.fullSuite.cases.filter((c) => !c.passed).map((c) => `${c.file}::${c.name}`).join("; ")}` };
  if (g.modifiedExistingTests.length) return { ok: false, reason: `modified_existing_tests: ${g.modifiedExistingTests.join(",")}` };
  return { ok: true, reason: "pass" };
}

// ---------- 5. orchestration ----------
export async function replayTask(task: ReplayTask, setup: Setup, opts: { workRoot: string; timeoutMs?: number; runId?: string; skipAgent?: boolean }): Promise<ReplayResult> {
  const runId = opts.runId ?? `${task.id}--${setup.id}--${Date.now()}`;
  const runDir = join(opts.workRoot, runId);
  const ws = join(runDir, "ws");
  const res: ReplayResult = { taskId: task.id, setupId: setup.id, ws, ok: false, reason: "" };
  try {
    buildSandbox(task.repoPath, task.parentSha, ws);
    res.isolation = proveIsolation(task.repoPath, task.parentSha, ws);
    if (!res.isolation.ok) return { ...res, reason: `isolation_failed: ${res.isolation.futureObjectsPresent.length} future objects` };
    applySetup(ws, setup);
    if (opts.skipAgent) {   // prep-only: NEVER grade here, grading overlays the hidden tests into ws
      res.reason = "prepared"; res.command = claudeCommand(setup, task.prompt);
      writeFileSync(join(runDir, "prep.json"), JSON.stringify(res, null, 2));
      return res;
    }
    const { cmd, m } = runAgent(ws, setup, task.prompt, opts.timeoutMs ?? 600_000);
    res.command = cmd; res.agent = m;
    // Grade even when the agent errored (partial work is still evidence), but the verdict keeps agent_error.
    res.grade = grade(task, ws, join(runDir, "grade"));
    Object.assign(res, verdict(res.agent, res.grade));
  } catch (e) {
    res.reason = `harness_error: ${(e as Error).message}`;
  }
  writeFileSync(join(runDir, "result.json"), JSON.stringify({ ...res, agent: res.agent && { ...res.agent, rawJson: undefined } }, null, 2));
  if (res.agent?.rawJson) writeFileSync(join(runDir, "agent.json"), JSON.stringify(res.agent.rawJson, null, 2));
  return res;
}

/** Grade-only entry for a sandbox prepared by replayTask({skipAgent}) and then worked on by an external agent. */
export function gradeExisting(task: ReplayTask, runDir: string, agent?: AgentMetrics): ReplayResult {
  const ws = join(runDir, "ws");
  const g = grade(task, ws, join(runDir, "grade"));
  const v = verdict(agent, g);
  const res: ReplayResult = { taskId: task.id, setupId: runDir.split("--")[1] ?? "?", ws, ...v, grade: g, agent };
  writeFileSync(join(runDir, "result.json"), JSON.stringify(res, null, 2));
  return res;
}
