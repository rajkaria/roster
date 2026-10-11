// Deterministic promotion gate (DESIGN.md §"Gate"). Pure code: the coordinator can't override it.
//
// promote(candidate) iff, on the replay set (incumbent replayed as the control):
//   hidden_pass(candidate) ≥ hidden_pass(incumbent)
//   ∧ regressions == 0          # incumbent passed, candidate failed, after reruns
//   ∧ scope_violations == 0
//   ∧ cost(candidate) ≤ budget
// ties → cheaper wins; still tied → keep incumbent; a tie at zero hidden passes never promotes
// no_signal: the incumbent passes none of its ≥ NO_SIGNAL_MIN_TASKS tasks with hidden tests, so the measure
//   can't rank setups and nothing is promoted.
//
// Conventions:
// - Results are Replay rows; several rows for one task are reruns (`attempt`).
// - Attempts carrying F6 (environment error) are excluded. A task with no usable attempt on
//   either side is excluded from the comparison (it is resampled upstream).
// - A side passes a task when a strict majority of its usable attempts have hidden_pass === true.
//   A 1–1 split is not a majority, so it counts as not passing.
// - A task the incumbent has but the candidate lacks counts as a candidate failure.
// - cost(setup) = sum over compared tasks of the mean cost of that task's usable attempts, so
//   reruns don't penalise a setup. Any unknown (null) cost makes the cost unknown.

import { FailureCode } from "../types.ts";
import type { GateVerdict, Replay } from "../types.ts";

/** Max attempts per task and side (DESIGN.md §"Grade" step 6). */
export const MAX_ATTEMPTS = 3;
/** Fewest tasks with hidden tests before an incumbent with zero passes counts as no signal. */
export const NO_SIGNAL_MIN_TASKS = 3;
export const NO_SIGNAL_REASON = "the incumbent fails its own tasks: the replay measure has no signal";

export type GateResults = Pick<
  Replay,
  "task_session_id" | "attempt" | "hidden_pass" | "scope_ok" | "cost_usd" | "failure_codes"
>[];

export interface GateOptions {
  /** Cost cap for the candidate, in USD. */
  budget: number;
}

/** How a hidden-pass tie was resolved: no tie, candidate cheaper, or kept incumbent. */
export type GateTie = "none" | "cheaper" | "incumbent";

export interface GateResult {
  verdict: GateVerdict;
  reasons: string[];
  /** Task ids the incumbent passed and the candidate failed, after reruns. */
  regressions: string[];
  ties: GateTie;
  hidden_pass: { incumbent: number; candidate: number };
  /** Task ids where any usable candidate attempt had scope_ok === false. */
  scope_violations: string[];
  cost: { incumbent: number | null; candidate: number | null };
  /** Task ids excluded because one side had no usable attempt (all F6). */
  excluded: string[];
}

interface Tally {
  attempts: number;
  passes: number;
  scopeViolation: boolean;
  /** Mean usable-attempt cost; null when any cost is unknown. */
  cost: number | null;
  /** The task has hidden tests: some usable attempt reports hidden_pass. Judge-only tasks report null. */
  tests: boolean;
}

function usable(r: GateResults[number]): boolean {
  return !r.failure_codes.includes(FailureCode.F6);
}

function tally(results: GateResults): Map<string, Tally> {
  const groups = new Map<string, GateResults>();
  for (const r of results) {
    if (!usable(r)) {
      if (!groups.has(r.task_session_id)) groups.set(r.task_session_id, []);
      continue;
    }
    const g = groups.get(r.task_session_id);
    if (g) g.push(r);
    else groups.set(r.task_session_id, [r]);
  }
  const out = new Map<string, Tally>();
  for (const [task, rs] of groups) {
    let sum = 0;
    let known = true;
    for (const r of rs) {
      if (r.cost_usd === null) known = false;
      else sum += r.cost_usd;
    }
    out.set(task, {
      attempts: rs.length,
      passes: rs.filter((r) => r.hidden_pass === true).length,
      scopeViolation: rs.some((r) => r.scope_ok === false),
      cost: known && rs.length > 0 ? sum / rs.length : null,
      tests: rs.some((r) => r.hidden_pass !== null),
    });
  }
  return out;
}

function passes(t: Tally | undefined): boolean {
  return t !== undefined && t.passes * 2 > t.attempts;
}

/** Majority is settled once no further attempt (up to MAX_ATTEMPTS) could flip it. */
function settled(t: Tally | undefined): boolean {
  if (!t || t.attempts === 0) return false; // missing: needs a first attempt
  const remaining = Math.max(0, MAX_ATTEMPTS - t.attempts);
  const fails = t.attempts - t.passes;
  return remaining === 0 || t.passes > fails + remaining || fails >= t.passes + remaining;
}

export interface Discordant {
  task_session_id: string;
  /** Which sides need another attempt. */
  rerun: ("incumbent" | "candidate")[];
}

/**
 * Tasks where the two setups split and at least one side's majority is not yet settled within
 * k = MAX_ATTEMPTS. Run one more attempt on each listed side, then call again until empty.
 */
export function discordant(incumbent: GateResults, candidate: GateResults): Discordant[] {
  const inc = tally(incumbent);
  const cand = tally(candidate);
  const tasks = [...new Set([...inc.keys(), ...cand.keys()])].sort();
  const out: Discordant[] = [];
  for (const task of tasks) {
    const i = inc.get(task);
    const c = cand.get(task);
    // All-F6 on either side: the task is excluded and resampled, not rerun.
    if (i?.attempts === 0 || c?.attempts === 0) continue;
    if (passes(i) === passes(c)) continue;
    const rerun: Discordant["rerun"] = [];
    if (!settled(i)) rerun.push("incumbent");
    if (!settled(c)) rerun.push("candidate");
    if (rerun.length > 0) out.push({ task_session_id: task, rerun });
  }
  return out;
}

function totalCost(t: Map<string, Tally>, tasks: string[]): number | null {
  let sum = 0;
  for (const task of tasks) {
    const c = t.get(task)?.cost;
    if (c === null || c === undefined) return null;
    sum += c;
  }
  return sum;
}

function fmt(n: number | null): string {
  return n === null ? "unknown" : `$${n.toFixed(4)}`;
}

export function gate(incumbentResults: GateResults, candidateResults: GateResults, opts: GateOptions): GateResult {
  const inc = tally(incumbentResults);
  const cand = tally(candidateResults);

  const excluded: string[] = [];
  const tasks: string[] = [];
  for (const task of [...new Set([...inc.keys(), ...cand.keys()])].sort()) {
    const i = inc.get(task);
    const c = cand.get(task);
    const allF6 = (t: Tally | undefined) => t !== undefined && t.attempts === 0;
    if (allF6(i) || allF6(c)) excluded.push(task);
    // Tasks only the candidate ran are not part of the incumbent's replay set.
    else if (i) tasks.push(task);
  }

  const hidden = {
    incumbent: tasks.filter((t) => passes(inc.get(t))).length,
    candidate: tasks.filter((t) => passes(cand.get(t))).length,
  };
  const regressions = tasks.filter((t) => passes(inc.get(t)) && !passes(cand.get(t)));
  const scope_violations = tasks.filter((t) => cand.get(t)?.scopeViolation === true);
  const missing = tasks.filter((t) => !cand.has(t));
  const cost = { incumbent: totalCost(inc, tasks), candidate: missing.length ? null : totalCost(cand, tasks) };

  const reasons: string[] = [];
  if (tasks.length === 0) reasons.push("empty replay set: no comparable tasks");
  if (hidden.candidate < hidden.incumbent)
    reasons.push(`hidden_pass ${hidden.candidate} < incumbent ${hidden.incumbent}`);
  if (regressions.length > 0) reasons.push(`${regressions.length} regression(s) after reruns: ${regressions.join(", ")}`);
  if (scope_violations.length > 0)
    reasons.push(`${scope_violations.length} scope violation(s): ${scope_violations.join(", ")}`);
  if (missing.length > 0) reasons.push(`candidate missing results for: ${missing.join(", ")}`);
  if (cost.candidate === null) reasons.push("candidate cost unknown; cannot verify budget");
  else if (cost.candidate > opts.budget) reasons.push(`cost ${fmt(cost.candidate)} > budget ${fmt(opts.budget)}`);

  // The incumbent passing none of its tasks with hidden tests says the measure is broken, not that setups are equal.
  const testTasks = tasks.filter((t) => inc.get(t)?.tests === true);
  if (testTasks.length >= NO_SIGNAL_MIN_TASKS && testTasks.every((t) => !passes(inc.get(t)))) {
    reasons.unshift(NO_SIGNAL_REASON);
    return { verdict: "no_signal", reasons, regressions, ties: "none", hidden_pass: hidden, scope_violations, cost, excluded };
  }

  let ties: GateTie = "none";
  if (reasons.length === 0 && hidden.candidate === hidden.incumbent) {
    // A 0–0 tie carries no quality signal: cost alone never promotes.
    if (hidden.candidate === 0) {
      ties = "incumbent";
      reasons.push("tie at 0 hidden passes: no quality signal, keep incumbent");
      return { verdict: "reject", reasons, regressions, ties, hidden_pass: hidden, scope_violations, cost, excluded };
    }
    // Rules passed with equal hidden_pass: candidate must be strictly cheaper.
    if (cost.incumbent !== null && cost.candidate !== null && cost.candidate < cost.incumbent) {
      ties = "cheaper";
      reasons.push(`tie on hidden_pass ${hidden.candidate}; candidate cheaper ${fmt(cost.candidate)} < ${fmt(cost.incumbent)}`);
      return { verdict: "promote", reasons, regressions, ties, hidden_pass: hidden, scope_violations, cost, excluded };
    }
    ties = "incumbent";
    reasons.push(
      `tie on hidden_pass ${hidden.candidate}; candidate not cheaper (${fmt(cost.candidate)} vs ${fmt(cost.incumbent)}), keep incumbent`,
    );
    return { verdict: "reject", reasons, regressions, ties, hidden_pass: hidden, scope_violations, cost, excluded };
  }

  if (reasons.length > 0)
    return { verdict: "reject", reasons, regressions, ties, hidden_pass: hidden, scope_violations, cost, excluded };
  reasons.push(`hidden_pass ${hidden.candidate} > incumbent ${hidden.incumbent}, 0 regressions, within budget`);
  return { verdict: "promote", reasons, regressions, ties, hidden_pass: hidden, scope_violations, cost, excluded };
}
