// The coordinator: a tool-calling loop on src/llm (DESIGN.md §"Plan (coordinator)", §"Coordinator tools", §"Recovery").
// It plans, replays, reads the gate and decides the next action until a candidate is promoted, it gives up honestly,
// or it hits budget_usd (LLM cost plus replay cost) or MAX_TURNS. Every step is appended to the `events` table in
// .roster/roster.db, and a run with the same id resumes from there.
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ATTR } from "../obs/attributes.ts";
import { withSpan } from "../obs/index.ts";
import { type Detection, detect } from "../obs/detections.ts";
import type { ChatMessage, LlmClient } from "../llm/types.ts";
import type { Plan, Replay } from "../types.ts";
import { planFile, writePlanFile } from "./plan.ts";
import {
  type Decision,
  executeToolCall,
  initialState,
  planId,
  type RunState,
  TOOL_SPECS,
  type ToolBackend,
  type ToolContext,
} from "./tools.ts";

/** D1–D4 over replay rows. A null hidden or scope result (no signal on that track) is not a failure. D2 needs line-mapping data replays don't carry. */
export function detectionsFor(replays: Replay[], incumbent: string | null): Detection[] {
  return detect({
    replays: replays.map((r) => ({
      task: r.task_session_id,
      setup: r.setup_id,
      suitePass: r.suite_pass === true,
      hiddenPass: r.hidden_pass !== false,
      scopeOk: r.scope_ok !== false,
      costUsd: r.cost_usd,
      failureCodes: r.failure_codes,
    })),
    incumbent: incumbent ?? "",
    unmappedLineShare: {},
  });
}

export const MAX_TURNS = 40;
export const DEFAULT_DB = ".roster/roster.db";

export const SYSTEM_PROMPT = `You are Roster's coordinator. Roster runs performance reviews for AI coding agents: it replays past tasks under the incumbent setup and candidate setups, grades them, and lets a deterministic gate decide promotion.

You decide what to try next. The gate decides what ships. Never claim a result the tools didn't return.

How to work:
- Read the scorecard, then call plan_replays with a one-paragraph rationale, the suspect setup, at most 3 candidates and at most 12 tasks.
- Replay the incumbent (as the control) and the candidates with run_replays, inspect results, rerun disagreements, and classify failures.
- Call gate for a candidate. If it promotes, call promote. If it rejects, replan with plan_replays and try the next candidate.
- If a task hits F6 (environment error), replan with a resampled task set.
- If no candidate passes, finish with outcome "no_better_setup". That is a valid result.
- The budget is a hard stop. Every tool answers with JSON; {"ok":false} means the call failed and you must not treat it as a result.`;

export type StopReason = "promoted" | "no_better_setup" | "budget" | "max_turns" | "stopped" | "llm_error";

/** Outcomes after which resuming does nothing more. */
const FINAL: ReadonlySet<StopReason> = new Set(["promoted", "no_better_setup", "stopped"]);

export interface RunResult {
  runId: string;
  outcome: StopReason;
  promoted: string | null;
  summary: string;
  turns: number;
  llmUsd: number;
  replayUsd: number;
  spentUsd: number;
  /** LLM calls src/price could not price; their cost is not in llmUsd. */
  unpricedLlmCalls: number;
  decisions: Decision[];
  planPath: string | null;
  decisionsPath: string;
  resumed: boolean;
}

export interface CoordinatorOptions {
  repo: string;
  budgetUsd: number;
  llm: LlmClient;
  backend: ToolBackend;
  /** Where plan.json and decisions.json go. */
  outDir: string;
  /** Default DEFAULT_DB. */
  dbPath?: string;
  /** Resume this run when its events exist; otherwise start it under this id. */
  runId?: string;
  reviewId?: string;
  model?: string;
  temperature?: number;
  maxTurns?: number;
  now?: () => Date;
}

interface StoredEvent {
  seq: number;
  kind: "start" | "llm" | "tool" | "note" | "end";
  payload: Record<string, unknown>;
}

/** The append-only step log plus the plans and gate_decisions tables (DESIGN.md §"Data model"). */
export class EventStore {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
      payload TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (run_id, seq))`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY, review_id TEXT NOT NULL, json TEXT NOT NULL, rationale TEXT NOT NULL, created_at TEXT NOT NULL)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS gate_decisions (
      id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, candidate TEXT NOT NULL, verdict TEXT NOT NULL,
      reasons TEXT NOT NULL, trace_url TEXT)`);
  }

  events(runId: string): StoredEvent[] {
    return this.db
      .query<{ seq: number; kind: StoredEvent["kind"]; payload: string }, [string]>(
        "SELECT seq, kind, payload FROM events WHERE run_id = ? ORDER BY seq",
      )
      .all(runId)
      .map((r) => ({ seq: r.seq, kind: r.kind, payload: JSON.parse(r.payload) }));
  }

  append(runId: string, kind: StoredEvent["kind"], payload: Record<string, unknown>, at: Date): void {
    const row = this.db.query<{ n: number | null }, [string]>("SELECT MAX(seq) AS n FROM events WHERE run_id = ?").get(runId);
    this.db
      .query("INSERT INTO events (run_id, seq, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(runId, (row?.n ?? 0) + 1, kind, JSON.stringify(payload), at.toISOString());
  }

  savePlan(plan: Plan): void {
    this.db
      .query("INSERT OR REPLACE INTO plans (id, review_id, json, rationale, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(plan.id, plan.review_id, plan.json, plan.rationale, plan.created_at);
  }

  saveDecision(d: Decision): void {
    this.db
      .query("INSERT OR REPLACE INTO gate_decisions (id, plan_id, candidate, verdict, reasons, trace_url) VALUES (?, ?, ?, ?, ?, ?)")
      .run(`${d.plan_id}:${d.candidate}`, d.plan_id, d.candidate, d.verdict, JSON.stringify(d.reasons), d.trace_url);
  }

  close(): void {
    this.db.close();
  }
}

/** Rebuilds a run from its events: the conversation, the last state snapshot and the LLM spend. */
function rebuild(events: StoredEvent[]) {
  const messages: ChatMessage[] = [];
  let state = initialState();
  let llmUsd = 0;
  let unpriced = 0;
  let turns = 0;
  let ended: RunResult | null = null;
  for (const e of events) {
    const p = e.payload;
    if (Array.isArray(p.messages)) messages.push(...(p.messages as ChatMessage[]));
    if (p.message) messages.push(p.message as ChatMessage);
    if (p.state) state = p.state as RunState;
    if (e.kind === "llm") {
      turns++;
      if (typeof p.costUsd === "number") llmUsd += p.costUsd;
      else unpriced++;
    }
    ended = e.kind === "end" ? (p.result as RunResult) : null;
  }
  return { messages, state, llmUsd, unpriced, turns, ended };
}

/** A fresh run id, e.g. "run-20261010143000-k3x9". */
export const newRunId = (now: Date) =>
  `run-${now.toISOString().replace(/\D/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;

/** Attempts an LLM error reports (LlmCallError carries them), else 1. */
function attemptsOf(err: unknown): number {
  const n = typeof err === "object" && err !== null ? (err as { attempts?: unknown }).attempts : undefined;
  return typeof n === "number" && n > 0 ? n : 1;
}

const shellArg = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The CLI command that resumes a run. */
export const resumeCommand = (repo: string, runId: string, budgetUsd: number) =>
  `roster run ${shellArg(repo)} --run-id ${shellArg(runId)} --budget ${budgetUsd}`;

/** Runs (or resumes) the coordinator until promotion, an honest give-up, the budget or MAX_TURNS. */
export async function runCoordinator(opts: CoordinatorOptions): Promise<RunResult> {
  const now = opts.now ?? (() => new Date());
  const maxTurns = opts.maxTurns ?? MAX_TURNS;
  const store = new EventStore(opts.dbPath ?? DEFAULT_DB);
  const runId = opts.runId ?? newRunId(now());
  const reviewId = opts.reviewId ?? runId;
  try {
    const prior = store.events(runId);
    const resumed = prior.length > 0;
    let { messages, state, llmUsd, unpriced, turns, ended } = rebuild(prior);
    if (ended && FINAL.has(ended.outcome)) return { ...ended, resumed: true };

    const log = (kind: StoredEvent["kind"], payload: Record<string, unknown>) => store.append(runId, kind, payload, now());
    if (!resumed) {
      const start: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Review ${opts.repo}. Run id ${runId}. Budget $${opts.budgetUsd} for LLM and replay cost together. Start by reading the scorecard.`,
        },
      ];
      messages.push(...start);
      log("start", { messages: start, config: { repo: opts.repo, budgetUsd: opts.budgetUsd, reviewId } });
    }

    const ctx: ToolContext = {
      runId,
      repo: opts.repo,
      budgetUsd: opts.budgetUsd,
      spentUsd: () => llmUsd + state.replayUsd,
    };
    let planPath: string | null = null;
    const decisionsPath = join(opts.outDir, "decisions.json");
    const writePlan = () => {
      const plan = state.plans.at(-1);
      if (!plan) return;
      planPath = writePlanFile(opts.outDir, planFile(runId, state.plans));
      store.savePlan({
        id: planId(runId, plan),
        review_id: reviewId,
        json: JSON.stringify(plan.body),
        rationale: plan.body.rationale,
        created_at: plan.created_at,
      });
    };
    const result = (outcome: StopReason, summary: string): RunResult => ({
      runId,
      outcome,
      promoted: state.promoted,
      summary,
      turns,
      llmUsd,
      replayUsd: state.replayUsd,
      spentUsd: llmUsd + state.replayUsd,
      unpricedLlmCalls: unpriced,
      decisions: state.decisions,
      planPath,
      decisionsPath,
      resumed,
    });
    /** D1–D4 over every replay of the run's plans, one GUARDRAIL span each. A backend that can't list replays yields none. */
    const runDetections = async (): Promise<Detection[]> => {
      const rows = new Map<string, Replay>();
      for (const plan of state.plans) {
        try {
          for (const r of await opts.backend.getReplayResults({ plan_id: planId(runId, plan) })) rows.set(r.id, r);
        } catch {
          // Not available (or no replays yet): nothing to detect over for this plan.
        }
      }
      const found = detectionsFor([...rows.values()], state.plans.at(-1)?.body.suspect ?? null);
      for (const d of found) {
        await withSpan("GUARDRAIL", `detection ${d.id}`, { setup: d.setup, task: d.task, repo: opts.repo }, async (span) => {
          span.setAttribute("roster.detection", d.id);
          span.setAttribute("roster.detection_detail", d.detail);
        });
      }
      return found;
    };
    const writeDecisions = (r: RunResult, detections: Detection[]) => {
      mkdirSync(opts.outDir, { recursive: true });
      const doc = {
        run_id: runId,
        repo: opts.repo,
        outcome: r.outcome,
        promoted: r.promoted,
        summary: r.summary,
        budget_usd: opts.budgetUsd,
        spent: { llm_usd: r.llmUsd, replay_usd: r.replayUsd, total_usd: r.spentUsd, unpriced_llm_calls: r.unpricedLlmCalls },
        turns: r.turns,
        excluded_tasks: state.excludedTasks,
        decisions: state.decisions,
        detections,
      };
      writeFileSync(decisionsPath, JSON.stringify(doc, null, 2) + "\n");
    };
    writePlan();

    const overBudget = () => ctx.spentUsd() >= opts.budgetUsd;
    const budgetStop = () =>
      `budget stop: spent $${ctx.spentUsd().toFixed(4)} of $${opts.budgetUsd} (LLM $${llmUsd.toFixed(4)}, replays $${state.replayUsd.toFixed(4)})`;

    const loop = async (): Promise<RunResult> => {
      for (;;) {
        // Answer the latest assistant turn's tool calls that have no answer yet (all of them, unless resuming).
        const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
        if (lastAssistant?.role === "assistant" && lastAssistant.tool_calls?.length) {
          const answered = new Set(messages.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : [])));
          for (const call of lastAssistant.tool_calls) {
            if (answered.has(call.id)) continue;
            if (overBudget()) return result("budget", budgetStop());
            const plans = state.plans.length;
            const decisions = state.decisions.length;
            const out = await executeToolCall(call, state, ctx, opts.backend);
            const message: ChatMessage = { role: "tool", tool_call_id: call.id, content: out.content };
            messages.push(message);
            log("tool", { message, name: call.name, ok: out.ok, state });
            if (state.plans.length !== plans) writePlan();
            for (const d of state.decisions.slice(decisions)) store.saveDecision(d);
            if (state.promoted && call.name === "promote" && out.ok) {
              return result("promoted", `the gate approved ${state.promoted} and it was promoted`);
            }
            if (state.finished) return result(state.finished.outcome, state.finished.summary);
          }
        }
        if (state.notes.length) {
          const message: ChatMessage = { role: "user", content: `[roster] ${state.notes.splice(0).join("\n")}` };
          messages.push(message);
          log("note", { message, state });
        }
        if (overBudget()) return result("budget", budgetStop());
        if (turns >= maxTurns) return result("max_turns", `stopped after ${turns} turns (limit ${maxTurns})`);

        let reply;
        try {
          reply = await opts.llm.chat({ messages, tools: TOOL_SPECS, model: opts.model, temperature: opts.temperature ?? 0 });
        } catch (err) {
          // Every finished step is already in the events log, so the run resumes from here under the same id.
          const message = err instanceof Error ? err.message : String(err);
          const attempts = attemptsOf(err);
          log("note", { llm_error: { message, attempts } });
          return result(
            "llm_error",
            `LLM call failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${message}. State is saved; resume with: ${resumeCommand(opts.repo, runId, opts.budgetUsd)}`,
          );
        }
        turns++;
        if (reply.costUsd === null) unpriced++;
        else llmUsd += reply.costUsd;
        messages.push(reply.message);
        log("llm", { message: reply.message, costUsd: reply.costUsd, usage: reply.usage, model: reply.model });
        if (reply.toolCalls.length === 0) {
          return result("stopped", reply.message.content ?? "the model stopped without calling a tool");
        }
      }
    };

    const finalResult = await withSpan("AGENT", "coordinator", { repo: opts.repo }, async (span) => {
      const r = await loop();
      span.setAttribute(ATTR.costUsd, r.spentUsd);
      return r;
    });
    log("end", { result: finalResult });
    writeDecisions(finalResult, await runDetections());
    return finalResult;
  } finally {
    store.close();
  }
}
