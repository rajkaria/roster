// In-process tools the coordinator model may call (DESIGN.md §"Coordinator tools").
// Each tool validates its arguments, runs inside a TOOL span, and answers with JSON. Bad calls get an error
// message back, never a crash. The gate decides what ships: `promote` refuses any candidate the gate did not approve.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fetchCheckpoints } from "../ingest/fetch.ts";
import { parseCheckpoints } from "../ingest/parse.ts";
import { identify } from "../identity/index.ts";
import { ATTR } from "../obs/attributes.ts";
import { type SpanAttrs, withSpan } from "../obs/index.ts";
import { reviewSlug, summarizeSetups } from "../review/export.ts";
import { FailureCode, type GateDecision, type Outcome, type Replay, type Review, type Session } from "../types.ts";
import type { ToolCall, ToolSpec } from "../llm/types.ts";
import { checkPlan, type PlanRevision } from "./plan.ts";

/** A gate decision as the coordinator records it: every rejection names its failed tasks. */
export interface Decision extends GateDecision {
  failed_tasks: string[];
}

export type FinishOutcome = "promoted" | "no_better_setup";

/** Everything a run has decided so far. JSON-serialisable: it is snapshotted into the events log for resume. */
export interface RunState {
  plans: PlanRevision[];
  decisions: Decision[];
  promoted: string | null;
  reverted: string[];
  /** Tasks that hit F6; excluded from later plans. */
  excludedTasks: string[];
  replayUsd: number;
  finished: { outcome: FinishOutcome; summary: string } | null;
  /** Messages for the coordinator to pass to the model before its next turn (replan requests). */
  notes: string[];
}

export function initialState(): RunState {
  return { plans: [], decisions: [], promoted: null, reverted: [], excludedTasks: [], replayUsd: 0, finished: null, notes: [] };
}

export interface ReplayBatch {
  replays: Replay[];
  cost_usd: number;
}

/** What the tools wrap. Methods that throw NotAvailableError report "not available yet" to the model. */
export interface ToolBackend {
  ingestRepo(a: { repo: string }): Promise<unknown>;
  getScorecard(a: { repo: string }): Promise<unknown>;
  /** A stratified task sample (≤ max), used when the model plans without naming tasks. */
  sampleTasks(a: { repo: string; max: number; exclude: string[] }): Promise<string[]>;
  runReplays(a: { plan_id: string; tasks: string[]; setups: string[]; max_cost_usd: number }): Promise<ReplayBatch>;
  getReplayResults(a: { plan_id: string; setup?: string }): Promise<Replay[]>;
  rerun(a: { plan_id: string; task: string; setup: string; max_cost_usd: number }): Promise<ReplayBatch>;
  classifyFailures(a: { plan_id: string; setup: string }): Promise<unknown>;
  /** Deterministic gate (DESIGN.md §"Gate"). The coordinator records it and cannot override it. */
  gate(a: { plan_id: string; candidate: string }): Promise<Omit<Decision, "failed_tasks"> & { failed_tasks?: string[] }>;
  promote(a: { candidate: string; decision: Decision }): Promise<unknown>;
  revert(a: { setup: string; reason: string }): Promise<unknown>;
}

export class NotAvailableError extends Error {
  constructor(what: string) {
    super(`not available yet: ${what}`);
  }
}

export interface ToolContext {
  runId: string;
  repo: string;
  budgetUsd: number;
  /** LLM plus replay spend so far. */
  spentUsd: () => number;
}

interface ToolDef {
  spec: ToolSpec;
  run(args: Record<string, unknown>, state: RunState, ctx: ToolContext, backend: ToolBackend, span: SpanSink): Promise<unknown>;
}

interface SpanSink {
  attrs: SpanAttrs;
}

/** An error the model caused (bad arguments, wrong order). Reported back to it as `{ok:false,error}`. */
export class ToolError extends Error {}

const str = (description: string) => ({ type: "string", description });
const strs = (description: string) => ({ type: "array", items: { type: "string" }, description });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export function currentPlan(state: RunState): PlanRevision | null {
  return state.plans.at(-1) ?? null;
}

export function planId(runId: string, plan: PlanRevision): string {
  return `${runId}-p${plan.revision}`;
}

function requirePlan(state: RunState): PlanRevision {
  const plan = currentPlan(state);
  if (!plan) throw new ToolError("no plan yet: call plan_replays first");
  return plan;
}

function remaining(ctx: ToolContext): number {
  const left = ctx.budgetUsd - ctx.spentUsd();
  if (left <= 0) throw new ToolError(`budget exhausted: spent $${ctx.spentUsd().toFixed(4)} of $${ctx.budgetUsd}`);
  return left;
}

/** Records replay spend and F6 exclusions from a batch of replays. */
function absorb(state: RunState, replays: Replay[], cost: number): void {
  state.replayUsd += Number.isFinite(cost) && cost > 0 ? cost : 0;
  const f6 = [...new Set(replays.filter((r) => r.failure_codes.includes(FailureCode.F6)).map((r) => r.task_session_id))].filter(
    (t) => !state.excludedTasks.includes(t),
  );
  if (f6.length) {
    state.excludedTasks.push(...f6);
    state.notes.push(
      `F6 (environment or setup error) on task(s) ${f6.join(", ")}. They are excluded. Replan: call plan_replays with a resampled task set.`,
    );
  }
}

const TOOLS: ToolDef[] = [
  {
    spec: {
      name: "ingest_repo",
      description: "Fetch the repo's Entire checkpoints and list its sessions and setups.",
      parameters: obj({}),
    },
    run: (_a, _s, ctx, b) => b.ingestRepo({ repo: ctx.repo }),
  },
  {
    spec: {
      name: "get_scorecard",
      description: "The observational (level A) scorecard per setup, and the review's suspect label.",
      parameters: obj({}),
    },
    run: (_a, _s, ctx, b) => b.getScorecard({ repo: ctx.repo }),
  },
  {
    spec: {
      name: "plan_replays",
      description:
        "Write or revise plan.json. Give a one-paragraph rationale, the suspect setup, ≤ 3 candidate setup ids and ≤ 12 task session ids (omit tasks for a stratified sample). Call again to replan after a gate rejection or F6.",
      parameters: obj(
        {
          rationale: str("One paragraph: why these tasks and candidates."),
          suspect: { type: ["string", "null"], description: "The suspect (incumbent) setup id, or null." },
          candidates: strs("Candidate setup ids, at most 3."),
          tasks: strs("Task session ids, at most 12, stratified by difficulty tercile."),
          stop_rules: strs("Stop rules. Defaults apply when omitted."),
          budget_usd: { type: "number", description: "May lower, never raise, the run budget." },
          reason: str("Why you are (re)planning."),
        },
        ["rationale", "candidates"],
      ),
    },
    async run(a, state, ctx, b) {
      const input = { ...a };
      if (input.tasks === undefined) {
        input.tasks = await b.sampleTasks({ repo: ctx.repo, max: 12, exclude: state.excludedTasks });
      }
      const rejected = new Set(state.decisions.filter((d) => d.verdict === "reject").map((d) => d.candidate));
      const check = checkPlan(input, {
        budgetUsd: ctx.budgetUsd,
        previous: state.plans,
        excludedTasks: new Set(state.excludedTasks),
        rejected,
        reason: typeof a.reason === "string" && a.reason ? a.reason : state.plans.length ? "replan" : "initial",
      });
      if (!check.ok) throw new ToolError(`plan rejected: ${check.errors.join("; ")}`);
      state.plans.push(check.revision);
      return { plan_id: planId(ctx.runId, check.revision), ...check.revision };
    },
  },
  {
    spec: {
      name: "run_replays",
      description: "Replay the plan's tasks at their parent commits under the given setups (include the incumbent as control).",
      parameters: obj({ setups: strs("Setup ids to replay."), tasks: strs("Subset of the plan's tasks; default all.") }, ["setups"]),
    },
    async run(a, state, ctx, b, span) {
      const plan = requirePlan(state);
      const setups = a.setups as string[];
      if (setups.length === 0) throw new ToolError("setups: at least one setup id is required");
      const tasks = (a.tasks as string[] | undefined) ?? plan.body.tasks;
      const off = tasks.filter((t) => !plan.body.tasks.includes(t));
      if (off.length) throw new ToolError(`tasks not in the current plan: ${off.join(", ")}`);
      const batch = await b.runReplays({ plan_id: planId(ctx.runId, plan), tasks, setups, max_cost_usd: remaining(ctx) });
      absorb(state, batch.replays, batch.cost_usd);
      span.attrs.costUsd = batch.cost_usd;
      return batch;
    },
  },
  {
    spec: {
      name: "get_replay_results",
      description: "Replay rows for the current plan, optionally for one setup.",
      parameters: obj({ setup: str("Setup id.") }),
    },
    async run(a, state, ctx, b) {
      const plan = requirePlan(state);
      const replays = await b.getReplayResults({ plan_id: planId(ctx.runId, plan), setup: a.setup as string | undefined });
      absorb(state, replays, 0);
      return replays;
    },
  },
  {
    spec: {
      name: "rerun",
      description: "Rerun one task under one setup (for grader/judge disagreement or a split, up to k = 3).",
      parameters: obj({ task: str("Task session id."), setup: str("Setup id.") }, ["task", "setup"]),
    },
    async run(a, state, ctx, b, span) {
      const plan = requirePlan(state);
      span.attrs.task = a.task as string;
      span.attrs.setup = a.setup as string;
      const batch = await b.rerun({
        plan_id: planId(ctx.runId, plan),
        task: a.task as string,
        setup: a.setup as string,
        max_cost_usd: remaining(ctx),
      });
      absorb(state, batch.replays, batch.cost_usd);
      span.attrs.costUsd = batch.cost_usd;
      return batch;
    },
  },
  {
    spec: {
      name: "classify_failures",
      description: "Failure taxonomy (F1–F7) for one setup's replays in the current plan.",
      parameters: obj({ setup: str("Setup id.") }, ["setup"]),
    },
    async run(a, state, ctx, b) {
      const plan = requirePlan(state);
      return b.classifyFailures({ plan_id: planId(ctx.runId, plan), setup: a.setup as string });
    },
  },
  {
    spec: {
      name: "propose_rules_candidate",
      description: "Patch the suspect's rules file from its top failure codes into a new candidate.",
      parameters: obj({ setup: str("Setup id to mutate."), failure_codes: strs("Failure codes to answer.") }),
    },
    async run() {
      throw new NotAvailableError("propose_rules_candidate (src/candidates is not built)");
    },
  },
  {
    spec: {
      name: "gate",
      description: "Run the deterministic gate for one candidate against the incumbent on the current plan. Its verdict is final.",
      parameters: obj({ candidate: str("Candidate setup id.") }, ["candidate"]),
    },
    async run(a, state, ctx, b, span) {
      const plan = requirePlan(state);
      const candidate = a.candidate as string;
      if (!plan.body.candidates.includes(candidate)) throw new ToolError(`${candidate} is not a candidate in the current plan`);
      span.attrs.setup = candidate;
      const raw = await withSpan("GUARDRAIL", "gate", { setup: candidate, evidenceLevel: "B" }, () =>
        b.gate({ plan_id: planId(ctx.runId, plan), candidate }),
      );
      const decision: Decision = { ...raw, failed_tasks: raw.failed_tasks ?? [] };
      if (
        decision.candidate !== candidate ||
        decision.plan_id !== planId(ctx.runId, plan) ||
        (decision.verdict !== "promote" && decision.verdict !== "reject")
      ) {
        throw new Error(`gate returned a malformed decision for ${candidate}`);
      }
      state.decisions.push(decision);
      if (decision.verdict === "reject") {
        state.notes.push(
          `The gate rejected ${candidate}: ${decision.reasons.join("; ") || "no reasons given"}. Replan: call plan_replays with the next candidate, or finish with no_better_setup.`,
        );
      }
      return decision;
    },
  },
  {
    spec: {
      name: "promote",
      description: "Promote a candidate. Only works for a candidate the gate approved on the current plan.",
      parameters: obj({ candidate: str("Candidate setup id.") }, ["candidate"]),
    },
    async run(a, state, ctx, b, span) {
      const plan = requirePlan(state);
      const candidate = a.candidate as string;
      span.attrs.setup = candidate;
      if (state.promoted) throw new ToolError(`${state.promoted} is already promoted`);
      const decision = state.decisions.find(
        (d) => d.candidate === candidate && d.plan_id === planId(ctx.runId, plan) && d.verdict === "promote",
      );
      if (!decision) throw new ToolError(`the gate has not approved ${candidate} on the current plan; the gate decides what ships`);
      const res = await b.promote({ candidate, decision });
      state.promoted = candidate;
      return res;
    },
  },
  {
    spec: {
      name: "revert",
      description: "Revert a previously promoted setup.",
      parameters: obj({ setup: str("Setup id."), reason: str("Why.") }, ["setup", "reason"]),
    },
    async run(a, state, _ctx, b, span) {
      span.attrs.setup = a.setup as string;
      const res = await b.revert({ setup: a.setup as string, reason: a.reason as string });
      state.reverted.push(a.setup as string);
      if (state.promoted === a.setup) state.promoted = null;
      return res;
    },
  },
  {
    spec: {
      name: "finish",
      description:
        "End the run. outcome is \"promoted\" only after a successful promote; otherwise \"no_better_setup\" (a valid result). Summarise only what tools returned.",
      parameters: obj(
        { outcome: { type: "string", enum: ["promoted", "no_better_setup"] }, summary: str("What the tools showed.") },
        ["outcome", "summary"],
      ),
    },
    async run(a, state) {
      const outcome = a.outcome as FinishOutcome;
      if (outcome === "promoted" && !state.promoted) throw new ToolError("nothing was promoted; finish with no_better_setup");
      if (outcome === "no_better_setup" && state.promoted) throw new ToolError(`${state.promoted} was promoted; finish with promoted`);
      state.finished = { outcome, summary: a.summary as string };
      return state.finished;
    },
  },
];

export const TOOL_SPECS: ToolSpec[] = TOOLS.map((t) => t.spec);

type Prop = { type?: string | string[]; items?: { type: string }; enum?: string[] };

/** Checks parsed arguments against a tool's parameter schema. Returns the problems, empty when valid. */
export function validateArgs(spec: ToolSpec, args: unknown): string[] {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return ["arguments must be a JSON object"];
  const rec = args as Record<string, unknown>;
  const props = (spec.parameters.properties ?? {}) as Record<string, Prop>;
  const required = (spec.parameters.required ?? []) as string[];
  const errors: string[] = [];
  for (const r of required) if (rec[r] === undefined) errors.push(`missing required argument "${r}"`);
  for (const [k, v] of Object.entries(rec)) {
    const p = props[k];
    if (!p) {
      errors.push(`unknown argument "${k}"`);
      continue;
    }
    if (v === undefined) continue;
    const types = Array.isArray(p.type) ? p.type : [p.type];
    const ok = types.some((t) =>
      t === "string"
        ? typeof v === "string"
        : t === "number"
          ? typeof v === "number" && Number.isFinite(v)
          : t === "null"
            ? v === null
            : t === "array"
              ? Array.isArray(v) && v.every((x) => typeof x === "string")
              : true,
    );
    if (!ok) errors.push(`argument "${k}" must be ${types.join(" or ")}${p.items ? ` of ${p.items.type}` : ""}`);
    else if (p.enum && !p.enum.includes(v as string)) errors.push(`argument "${k}" must be one of ${p.enum.join(", ")}`);
  }
  return errors;
}

const MAX_RESULT_CHARS = 20_000;

export interface ToolOutcome {
  /** The tool message content sent back to the model. */
  content: string;
  ok: boolean;
}

/**
 * Runs one tool call from the model. Unknown tools, malformed JSON, bad arguments, tool misuse and backend
 * failures all come back as `{"ok":false,"error":...}`; this function does not throw.
 */
export async function executeToolCall(
  call: ToolCall,
  state: RunState,
  ctx: ToolContext,
  backend: ToolBackend,
): Promise<ToolOutcome> {
  const reply = (ok: boolean, body: Record<string, unknown>): ToolOutcome => {
    let content = JSON.stringify({ ok, ...body });
    if (content.length > MAX_RESULT_CHARS) content = `${content.slice(0, MAX_RESULT_CHARS)}… [truncated]`;
    return { ok, content };
  };
  const def = TOOLS.find((t) => t.spec.name === call.name);
  if (!def) return reply(false, { error: `unknown tool "${call.name}". Available: ${TOOL_SPECS.map((t) => t.name).join(", ")}` });
  let args: unknown;
  try {
    args = call.arguments.trim() === "" ? {} : JSON.parse(call.arguments);
  } catch (err) {
    return reply(false, { error: `arguments are not valid JSON (${err instanceof Error ? err.message : String(err)})` });
  }
  const problems = validateArgs(def.spec, args);
  if (problems.length) return reply(false, { error: `invalid arguments for ${call.name}: ${problems.join("; ")}` });

  const sink: SpanSink = { attrs: { repo: ctx.repo } };
  return withSpan("TOOL", call.name, sink.attrs, async (span) => {
    try {
      const result = await def.run(args as Record<string, unknown>, state, ctx, backend, sink);
      if (sink.attrs.setup !== undefined) span.setAttribute(ATTR.setup, sink.attrs.setup);
      if (sink.attrs.task !== undefined) span.setAttribute(ATTR.task, sink.attrs.task);
      if (sink.attrs.costUsd !== undefined) span.setAttribute(ATTR.costUsd, sink.attrs.costUsd);
      return reply(true, { result: result ?? null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply(false, { error: err instanceof ToolError || err instanceof NotAvailableError ? msg : `${call.name} failed: ${msg}` });
    }
  });
}

export interface DefaultBackendOptions {
  cacheDir?: string;
  reportsDir?: string;
}

/**
 * The backend over the modules that exist today: ingest (fetch → parse → identify) and the observational
 * review in reports/<slug>/. Replay, gate, promote and revert are not built yet and report so.
 */
export function defaultBackend(opts: DefaultBackendOptions = {}): ToolBackend {
  const cacheDir = resolve(opts.cacheDir ?? ".roster/cache");
  const reportsDir = resolve(opts.reportsDir ?? "reports");
  const readJson = <T>(repo: string, file: string): T | null => {
    const p = join(reportsDir, reviewSlug(repo), file);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
  };
  const missing = (what: string) => async (): Promise<never> => {
    throw new NotAvailableError(what);
  };
  return {
    async ingestRepo({ repo }) {
      const f = await fetchCheckpoints(repo, { cacheDir });
      if (f.backend === "none") throw new ToolError("no Entire checkpoints found in this repo");
      const sessions = parseCheckpoints(f.repoPath, f.backend === "refs" ? "git-refs" : "branch");
      const counts: Record<string, number> = {};
      for (const s of sessions) {
        const id = identify(s, f.repoPath).setupId ?? "unknown";
        counts[id] = (counts[id] ?? 0) + 1;
      }
      return { backend: f.backend, head: f.headSha, sessions: sessions.length, sessions_per_setup: counts };
    },
    async getScorecard({ repo }) {
      const review = readJson<Review>(repo, "review.json");
      if (!review) throw new ToolError(`no review for ${repo}; run \`roster review ${repo} --observational\` first`);
      const sessions = readJson<Session[]>(repo, "sessions.json") ?? [];
      const outcomes = readJson<Outcome[]>(repo, "outcomes.json") ?? [];
      return { review, setups: summarizeSetups(sessions, outcomes) };
    },
    sampleTasks: missing("stratified task sampling (src/difficulty is not built); name the tasks explicitly"),
    runReplays: missing("run_replays (src/replay is not built)"),
    getReplayResults: missing("get_replay_results (src/replay is not built)"),
    rerun: missing("rerun (src/replay is not built)"),
    classifyFailures: missing("classify_failures (src/grade has no taxonomy classifier yet)"),
    gate: missing("gate (src/gate is not built)"),
    promote: missing("promote (src/act is not built)"),
    revert: missing("revert (src/act is not built)"),
  };
}
