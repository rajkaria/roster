// plan.json: the coordinator's review plan (DESIGN.md §"Plan (coordinator)").
// The model proposes; this module enforces the limits: ≤ 12 tasks, ≤ 3 candidates per iteration, ≤ 2 iterations,
// and a budget that never exceeds the run's.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PlanBody } from "../types.ts";

export const MAX_TASKS = 12;
export const MAX_CANDIDATES = 3;
export const MAX_ITERATIONS = 2;

export const DEFAULT_STOP_RULES = [
  "promote the first candidate the gate approves",
  `at most ${MAX_CANDIDATES} candidates per iteration and ${MAX_ITERATIONS} iterations`,
  "stop at budget_usd (LLM cost plus replay cost)",
  "if no candidate passes the gate, the result is \"no better setup found\"",
];

/** One revision of the plan. A revision that adds a candidate never tried before starts a new iteration. */
export interface PlanRevision {
  revision: number;
  iteration: number;
  created_at: string;
  /** Why the coordinator (re)planned: "initial", "gate rejected E", "F6 on task t3", ... */
  reason: string;
  body: PlanBody;
}

/** What plan.json holds: the current PlanBody at the top level, plus the revisions that led to it. */
export interface PlanFile extends PlanBody {
  run_id: string;
  revision: number;
  iteration: number;
  history: Omit<PlanRevision, "body">[];
}

export interface PlanContext {
  budgetUsd: number;
  previous: PlanRevision[];
  /** Tasks excluded after F6; a plan may not include them again. */
  excludedTasks: ReadonlySet<string>;
  /** Candidates the gate already rejected; a plan may not include them again. */
  rejected: ReadonlySet<string>;
  reason: string;
  now?: () => Date;
}

export type PlanCheck = { ok: true; revision: PlanRevision } | { ok: false; errors: string[] };

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x !== "");

/** Validates a proposed plan against the limits and the run so far. Every problem is listed, not just the first. */
export function checkPlan(input: Record<string, unknown>, ctx: PlanContext): PlanCheck {
  const errors: string[] = [];
  const rationale = typeof input.rationale === "string" ? input.rationale.trim() : "";
  if (!rationale) errors.push("rationale: a one-paragraph rationale is required");

  const suspect = input.suspect ?? null;
  if (suspect !== null && typeof suspect !== "string") errors.push("suspect: must be a setup id or null");

  const tasks = input.tasks ?? [];
  if (!isStringArray(tasks)) errors.push("tasks: must be an array of session ids");
  else {
    if (tasks.length === 0) errors.push("tasks: at least one task is required");
    if (tasks.length > MAX_TASKS) errors.push(`tasks: at most ${MAX_TASKS}, got ${tasks.length}`);
    if (new Set(tasks).size !== tasks.length) errors.push("tasks: duplicates");
    const bad = tasks.filter((t) => ctx.excludedTasks.has(t));
    if (bad.length) errors.push(`tasks: ${bad.join(", ")} hit F6 and are excluded; resample`);
  }

  const candidates = input.candidates ?? [];
  if (!isStringArray(candidates)) errors.push("candidates: must be an array of setup ids");
  else {
    if (candidates.length === 0) errors.push("candidates: at least one candidate is required");
    if (candidates.length > MAX_CANDIDATES) errors.push(`candidates: at most ${MAX_CANDIDATES} per iteration, got ${candidates.length}`);
    if (new Set(candidates).size !== candidates.length) errors.push("candidates: duplicates");
    const bad = candidates.filter((c) => ctx.rejected.has(c));
    if (bad.length) errors.push(`candidates: the gate already rejected ${bad.join(", ")}`);
  }

  const stopRules = input.stop_rules ?? DEFAULT_STOP_RULES;
  if (!isStringArray(stopRules)) errors.push("stop_rules: must be an array of strings");

  let budget = ctx.budgetUsd;
  if (input.budget_usd !== undefined) {
    if (typeof input.budget_usd !== "number" || !(input.budget_usd > 0)) errors.push("budget_usd: must be a positive number");
    else budget = Math.min(input.budget_usd, ctx.budgetUsd);
  }

  const last = ctx.previous.at(-1);
  let iteration = last?.iteration ?? 1;
  if (last && isStringArray(candidates)) {
    const tried = new Set(ctx.previous.flatMap((p) => p.body.candidates));
    if (candidates.some((c) => !tried.has(c))) iteration++;
  }
  if (iteration > MAX_ITERATIONS) {
    errors.push(`iterations: at most ${MAX_ITERATIONS}; no new candidates may be added. Finish with no_better_setup if nothing passed.`);
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    revision: {
      revision: (last?.revision ?? 0) + 1,
      iteration,
      created_at: (ctx.now ?? (() => new Date()))().toISOString(),
      reason: ctx.reason,
      body: {
        suspect: suspect as string | null,
        tasks: tasks as string[],
        candidates: candidates as string[],
        budget_usd: budget,
        stop_rules: stopRules as string[],
        rationale,
      },
    },
  };
}

/** The plan.json document for the latest revision. */
export function planFile(runId: string, revisions: PlanRevision[]): PlanFile {
  const last = revisions.at(-1);
  if (!last) throw new Error("planFile: no plan revisions");
  return {
    ...last.body,
    run_id: runId,
    revision: last.revision,
    iteration: last.iteration,
    history: revisions.map(({ body: _body, ...meta }) => meta),
  };
}

/** Writes plan.json into `dir`. Returns its path. */
export function writePlanFile(dir: string, file: PlanFile): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "plan.json");
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
  return path;
}
