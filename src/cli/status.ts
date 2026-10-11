// `roster status`: where a run is — its last completed step, any step still in progress, the steps that failed,
// and the spend against the budget (DESIGN.md §"CLI", §"Data model"). The command reads the append-only `events`
// log that `roster run` writes into .roster/roster.db; renderStatus is pure over the same step log.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { DEFAULT_DB } from "../agent/coordinator.ts";
import type { Command } from "../cli.ts";
import { UsageError } from "./review.ts";

const USAGE = `usage: roster status [--db <path>] [--budget <usd>]

  --db <path>      the state database holding the run's step log (default ${DEFAULT_DB})
  --budget <usd>   what to compare the spend against; default: the budget recorded for the latest run

One line per step kind: the coordinator's tool calls are the steps, plus one "llm" step per model turn, which
carries that turn's cost. Everything the run reported is shown; nothing is inferred beyond the log.`;

/** One entry of a run's step log, oldest first. */
export interface StatusEvent {
  runId: string;
  step: string;
  status: "started" | "done" | "failed";
  /** ISO 8601. */
  at: string;
  /** This step's cost in USD, when it has one. */
  costUsd?: number;
}

/** The run of the last event in the log: the greatest `at`, ties and unparseable dates broken by log order. */
function latestRunId(events: readonly StatusEvent[]): string {
  let runId = events[events.length - 1]!.runId;
  let best = Number.NEGATIVE_INFINITY;
  for (const e of events) {
    const t = Date.parse(e.at);
    if (Number.isNaN(t)) continue;
    if (t >= best) {
      best = t;
      runId = e.runId;
    }
  }
  return runId;
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * Where the latest run is: its last completed step, the steps that started and never finished ("in progress"),
 * the steps whose last word was a failure, and the cost against the budget as "$x.xx of $y.yy".
 */
export function renderStatus(events: readonly StatusEvent[], budgetUsd: number): string {
  if (events.length === 0) return "no runs yet";
  const runId = latestRunId(events);
  const run = events.filter((e) => e.runId === runId);

  // What each step last said about itself: a step that started and never finished is still running, and a step
  // that failed and was not retried is a failure. A step that failed and then completed is neither.
  const last = new Map<string, StatusEvent["status"]>();
  for (const e of run) last.set(e.step, e.status);

  // The last step that finished and stayed finished: a step whose last word was a failure is not one.
  const lastDone = run.filter((e) => e.status === "done" && last.get(e.step) === "done").at(-1);
  const inProgress = [...last].filter(([, s]) => s === "started").map(([step]) => step);
  const failed = [...last].filter(([, s]) => s === "failed").map(([step]) => step);
  const spent = run.reduce((sum, e) => sum + (e.costUsd === undefined || !Number.isFinite(e.costUsd) ? 0 : e.costUsd), 0);

  const lines = [`run ${runId}`];
  if (lastDone) lines.push(`last completed step: ${lastDone.step}`);
  if (inProgress.length > 0) lines.push(`in progress: ${inProgress.join(", ")}`);
  if (failed.length > 0) lines.push(`failed steps: ${failed.join(", ")}`);
  lines.push(`cost: ${usd(spent)} of ${usd(Number.isFinite(budgetUsd) ? budgetUsd : 0)}`);
  return lines.join("\n");
}

interface EventRow {
  run_id: string;
  kind: string;
  payload: string;
  created_at: string;
}

/** The step a logged event is, or null for the events that are not steps (an unknown kind, the run's start). */
function stepOf(kind: string, payload: Record<string, unknown>): Pick<StatusEvent, "step" | "status" | "costUsd"> | null {
  switch (kind) {
    case "tool": {
      const name = typeof payload.name === "string" && payload.name.length > 0 ? payload.name : "tool";
      return { step: name, status: payload.ok === false ? "failed" : "done", costUsd: undefined };
    }
    case "llm": {
      const cost = typeof payload.costUsd === "number" ? payload.costUsd : undefined;
      return { step: "llm", status: "done", costUsd: cost };
    }
    // A note is either the run's own error (the LLM call that failed) or something the tools asked to surface.
    case "note":
      return payload.llm_error === undefined
        ? { step: "note", status: "done", costUsd: undefined }
        : { step: "llm", status: "failed", costUsd: undefined };
    case "end":
      return { step: "end", status: "done", costUsd: undefined };
    default:
      return null;
  }
}

export interface StatusLog {
  events: StatusEvent[];
  /** The budget the latest run was started with, when the log records one. */
  budgetUsd: number | undefined;
}

function parse(payload: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(payload);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Reads every run's step log from the state database, oldest first. A database that is missing, unreadable or
 * not a roster state database reads as no events rather than as an error.
 */
export function readStatusLog(dbPath: string): StatusLog {
  const empty: StatusLog = { events: [], budgetUsd: undefined };
  if (!existsSync(dbPath)) return empty;
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db
      .query<EventRow, []>("SELECT run_id, kind, payload, created_at FROM events ORDER BY id")
      .all();
    const events: StatusEvent[] = [];
    let budgetUsd: number | undefined;
    let budgetRun: string | undefined;
    for (const row of rows) {
      const payload = parse(row.payload);
      if (row.kind === "start") {
        const config = payload.config;
        const budget = typeof config === "object" && config !== null ? (config as Record<string, unknown>).budgetUsd : undefined;
        if (typeof budget === "number" && Number.isFinite(budget)) {
          budgetUsd = budget;
          budgetRun = row.run_id;
        }
        continue;
      }
      const step = stepOf(row.kind, payload);
      if (!step) continue;
      const event: StatusEvent = { runId: row.run_id, step: step.step, status: step.status, at: row.created_at };
      if (step.costUsd !== undefined) event.costUsd = step.costUsd;
      events.push(event);
    }
    // Only the latest run's recorded budget is the one status compares against.
    const latest = events.length > 0 ? latestRunId(events) : undefined;
    return { events, budgetUsd: budgetRun !== undefined && budgetRun === latest ? budgetUsd : undefined };
  } catch {
    return empty;
  } finally {
    db?.close();
  }
}

export interface StatusArgs {
  db: string;
  budgetUsd: number | undefined;
}

/** Parses the arguments after `status`. Throws UsageError on anything it does not accept. */
export function parseStatusArgs(args: string[]): StatusArgs {
  let db = DEFAULT_DB;
  let budget: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);
    const takeValue = (): string => {
      if (eq !== -1) return a.slice(eq + 1);
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${name} needs a value`);
      return v;
    };
    if (name === "--db") db = takeValue();
    else if (name === "--budget") budget = takeValue();
    else throw new UsageError(`unexpected argument ${a}`);
  }
  if (budget === undefined) return { db, budgetUsd: undefined };
  const budgetUsd = Number(budget);
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0) throw new UsageError(`--budget must be a non-negative number, got ${budget}`);
  return { db, budgetUsd };
}

export const statusCommand: Command = {
  name: "status",
  summary: "show where the latest run is: last step, failures, cost vs budget",
  usage: USAGE,
  async run(args) {
    let parsed: StatusArgs;
    try {
      parsed = parseStatusArgs(args);
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      console.error(`roster status: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    const log = readStatusLog(parsed.db);
    if (log.events.length === 0) {
      console.log("no runs yet");
      return 0;
    }
    console.log(renderStatus(log.events, parsed.budgetUsd ?? log.budgetUsd ?? 0));
    return 0;
  },
};

if (import.meta.main) {
  process.exitCode = await statusCommand.run(process.argv.slice(2));
}
