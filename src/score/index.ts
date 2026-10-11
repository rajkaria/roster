// Outcomes table (DESIGN.md §"Score"). One row per session. Only mature sessions get metrics: the
// commit must be ≥ 5 first-parent commits and ≥ 6 h older than HEAD. Everything else is censored
// as `too_young` with null metrics (except `unattended`, which needs no commit age), and `censored` says why.

import { priceSession } from "../price/index.ts";
import type { Outcome, Session } from "../types.ts";
import { reverted } from "./revert.ts";
import { rework } from "./rework.ts";
import { survival } from "./survival.ts";

export const MATURE_MIN_COMMITS = 5;
export const MATURE_MIN_AGE_MS = 6 * 3600 * 1000;
/** Bucket for sessions whose setup is unknown (`setup_id` null). */
export const UNKNOWN_SETUP = "unknown";

/** Why a session has no metrics. `too_young`: the commit is not old enough yet. */
export type Censor = "too_young" | "no_commit" | "not_on_head";

/** An Outcome plus what aggregation needs. Cost is a spend, not a quality metric, so censored rows keep it. */
export interface ScoredOutcome extends Outcome {
  setup_id: string | null;
  commit_sha: string | null;
  /** null when the model or a price is unknown. */
  cost_usd: number | null;
  censored: Censor | null;
}

function git(repo: string, args: string[]): { ok: boolean; out: string } {
  const p = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim() };
}

function commitTimeMs(repo: string, rev: string): number {
  return Number(git(repo, ["log", "-1", "--format=%ct", rev]).out) * 1000;
}

/** Why `sha` is not mature against HEAD, or null when it is. */
export function maturity(repo: string, sha: string): Censor | null {
  if (!git(repo, ["merge-base", "--is-ancestor", sha, "HEAD"]).ok) return "not_on_head";
  const newer = Number(git(repo, ["rev-list", "--first-parent", "--count", `${sha}..HEAD`]).out);
  const age = commitTimeMs(repo, "HEAD") - commitTimeMs(repo, sha);
  return newer >= MATURE_MIN_COMMITS && age >= MATURE_MIN_AGE_MS ? null : "too_young";
}

/**
 * The session's own cost if ingest priced it, otherwise its summed tokens priced by src/price.
 * Sessions store totals, not per-request prompt sizes, so the tier uses the session's total prompt as a bound:
 * a session under 100k total is certainly short-tier; one over it is priced at the short tier and is a lower bound.
 */
export function sessionCostDetail(s: Session): { usd: number | null; lower_bound: boolean } {
  if (s.cost_usd !== null) return { usd: s.cost_usd, lower_bound: false };
  const promptTotal = s.tokens_in + s.cache_read + s.cache_write;
  const r = priceSession(
    s.model,
    {
      input: s.tokens_in,
      output: s.tokens_out,
      cache_read: s.cache_read,
      cache_write: s.cache_write,
      prompt_tokens_bound: promptTotal,
    },
    s.started_at,
  );
  return { usd: r.usd, lower_bound: r.lower_bound === true };
}

export function sessionCost(s: Session): number | null {
  return sessionCostDetail(s).usd;
}

export function scoreSessions(repo: string, sessions: Session[]): ScoredOutcome[] {
  return sessions.map((s) => {
    const base: ScoredOutcome = {
      session_id: s.id,
      status: "too_young",
      survival: null,
      reverted: null,
      rework_human: null,
      rework_agent: null,
      // Needs only the prompt count, not commit age, so censored sessions keep it.
      unattended: Number.isFinite(s.n_user_prompts) ? s.n_user_prompts === 1 : null,
      tests_at_commit: null,
      difficulty: null,
      tercile: null,
      setup_id: s.setup_id,
      commit_sha: s.commit_sha,
      cost_usd: sessionCost(s),
      censored: "no_commit",
    };
    if (s.commit_sha === null) return base;
    const censored = maturity(repo, s.commit_sha);
    if (censored) return { ...base, censored };
    const r = rework(repo, s.commit_sha);
    return {
      ...base,
      status: "mature",
      censored: null,
      survival: survival(repo, [s.commit_sha], "HEAD").ratio,
      reverted: reverted(repo, s.commit_sha),
      rework_human: r.human,
      rework_agent: r.agent,
    };
  });
}

export interface SetupAggregate {
  setup_id: string;
  /** All sessions of the setup, mature or censored. */
  sessions: number;
  mature: number;
  too_young: number;
  /** Mature sessions only. */
  reverted: number;
  /** Sessions with a known prompt count that needed exactly one prompt, mature or not. */
  unattended: number;
  /** Sessions with a known prompt count, mature or not: the denominator of the unattended share. */
  unattended_known: number;
  survival_sum: number;
  survival_mean: number | null;
  /** Σ cost over all sessions; null when any session's cost is unknown (a partial sum would understate spend). */
  cost_usd: number | null;
  /** Sessions with a known cost. Equals `sessions` exactly when cost_usd is non-null. */
  priced_sessions: number;
  cost_unknown: number;
  /**
   * Σ cost ÷ Σ survival over mature sessions with a known cost. null when there are none, when
   * Σ survival is 0, or when any mature session's cost is unknown (a partial sum would flatter it).
   */
  cost_per_surviving_change: number | null;
}

export function aggregateBySetup(outcomes: ScoredOutcome[]): SetupAggregate[] {
  const groups = new Map<string, ScoredOutcome[]>();
  for (const o of outcomes) {
    const k = o.setup_id ?? UNKNOWN_SETUP;
    groups.set(k, [...(groups.get(k) ?? []), o]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([setup_id, rows]) => {
      const mature = rows.filter((o) => o.status === "mature");
      const known = rows.filter((o) => o.cost_usd !== null);
      const survivalSum = mature.reduce((a, o) => a + (o.survival ?? 0), 0);
      const matureCost = mature.reduce((a, o) => a + (o.cost_usd ?? 0), 0);
      const matureCostKnown = mature.length > 0 && mature.every((o) => o.cost_usd !== null);
      return {
        setup_id,
        sessions: rows.length,
        mature: mature.length,
        too_young: rows.length - mature.length,
        reverted: mature.filter((o) => o.reverted).length,
        unattended: rows.filter((o) => o.unattended).length,
        unattended_known: rows.filter((o) => o.unattended !== null).length,
        survival_sum: survivalSum,
        survival_mean: mature.length ? survivalSum / mature.length : null,
        cost_usd: known.length === rows.length ? known.reduce((a, o) => a + (o.cost_usd ?? 0), 0) : null,
        priced_sessions: known.length,
        cost_unknown: rows.length - known.length,
        cost_per_surviving_change: matureCostKnown && survivalSum > 0 ? matureCost / survivalSum : null,
      };
    });
}

/** Report shape for reports/outcomes.json. Totals follow the rules scripts/sumcheck.ts checks. */
export function outcomesReport(outcomes: ScoredOutcome[]) {
  const setups = aggregateBySetup(outcomes);
  const bySetup = (pick: (a: SetupAggregate) => number) => Object.fromEntries(setups.map((a) => [a.setup_id, pick(a)]));
  const priced = setups.filter((a) => a.cost_usd !== null);
  return {
    sessions: { total: outcomes.length, by_setup: bySetup((a) => a.sessions) },
    mature: { total: outcomes.filter((o) => o.status === "mature").length, by_setup: bySetup((a) => a.mature) },
    too_young: { total: outcomes.filter((o) => o.status === "too_young").length, by_setup: bySetup((a) => a.too_young) },
    reverted: { total: outcomes.filter((o) => o.reverted).length, by_setup: bySetup((a) => a.reverted) },
    unattended: { total: outcomes.filter((o) => o.unattended).length, by_setup: bySetup((a) => a.unattended) },
    // Only setups with a known cost appear here; cost_unknown counts the sessions left out.
    cost_total_usd: priced.reduce((s, a) => s + (a.cost_usd ?? 0), 0),
    cost_by_setup: Object.fromEntries(priced.map((a) => [a.setup_id, a.cost_usd as number])),
    cost_unknown: { total: outcomes.filter((o) => o.cost_usd === null).length, by_setup: bySetup((a) => a.cost_unknown) },
    setups,
    outcomes,
  };
}
