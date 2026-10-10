// Names a suspect setup only when a difficulty-matched (tercile-stratified) comparison supports it.
// See docs/DESIGN.md §"Difficulty and review". The wording fields are the only labels the design allows.
import type { Outcome, Tercile } from "../types.ts";
import { mantelHaenszel, type MantelHaenszel, type Stratum } from "./stats.ts";

export const SUSPECT_LABEL = "suspect (level A, observational)";
export const NO_SUSPECT_LABEL = "no suspect";
export const INSUFFICIENT_LABEL = "insufficient data";

export const MIN_MATURE_SESSIONS = 8;
export const REWORK_BAD_THRESHOLD = 0.3;
const ALPHA = 0.05;

/** An outcome joined to the setup that produced its session (Outcome itself carries no setup id). */
export type SetupOutcome = Outcome & { setup_id: string | null };

export interface SuspectResult {
  setupId: string | null;
  or: number | null;
  ci95: [number, number] | null;
  p: number | null;
  /** Mature sessions of the reported setup. */
  n: number;
  label: typeof SUSPECT_LABEL | typeof NO_SUSPECT_LABEL | typeof INSUFFICIENT_LABEL;
  reason: string;
  /** Unmatched comparison (one pooled stratum) for the reported setup, for contrast only. Never used to flag. */
  raw: MantelHaenszel | null;
}

export const isBad = (o: Outcome): boolean => o.reverted === true || (o.rework_human ?? 0) > REWORK_BAD_THRESHOLD;

function strataFor(rows: SetupOutcome[], setupId: string): Stratum[] {
  const by = new Map<Tercile, Stratum>();
  for (const o of rows) {
    const t = o.tercile as Tercile;
    const s = by.get(t) ?? { a: 0, b: 0, c: 0, d: 0 };
    const bad = isBad(o);
    if (o.setup_id === setupId) {
      if (bad) s.a++;
      else s.b++;
    } else if (bad) s.c++;
    else s.d++;
    by.set(t, s);
  }
  return [...by.values()];
}

function collapse(strata: Stratum[]): Stratum {
  return strata.reduce((t, s) => ({ a: t.a + s.a, b: t.b + s.b, c: t.c + s.c, d: t.d + s.d }), { a: 0, b: 0, c: 0, d: 0 });
}

export function suspect(outcomes: SetupOutcome[]): SuspectResult {
  const rows = outcomes.filter((o) => o.status === "mature" && o.tercile !== null && o.setup_id !== null);
  const counts = new Map<string, number>();
  for (const o of rows) counts.set(o.setup_id!, (counts.get(o.setup_id!) ?? 0) + 1);
  const eligible = [...counts]
    .filter(([, n]) => n >= MIN_MATURE_SESSIONS)
    .map(([id]) => id)
    .sort();

  if (eligible.length === 0) {
    return {
      setupId: null, or: null, ci95: null, p: null, n: 0, label: INSUFFICIENT_LABEL, raw: null,
      reason: `no setup has ≥ ${MIN_MATURE_SESSIONS} mature sessions`,
    };
  }

  const results = eligible.map((id) => {
    const strata = strataFor(rows, id);
    return { id, n: counts.get(id)!, mh: mantelHaenszel(strata), raw: mantelHaenszel([collapse(strata)]) };
  });
  const flagged = results.filter((r) => r.mh.or > 1 && r.mh.ci95[0] > 1 && r.mh.p < ALPHA);
  if (flagged.length > 0) {
    const best = flagged.sort((x, y) => x.mh.p - y.mh.p || x.id.localeCompare(y.id))[0]!;
    return {
      setupId: best.id, or: best.mh.or, ci95: best.mh.ci95, p: best.mh.p, n: best.n, label: SUSPECT_LABEL, raw: best.raw,
      reason: `difficulty-matched odds ratio ${best.mh.or.toFixed(2)} (p ${best.mh.p.toFixed(4)}) for ${best.id} vs the rest`,
    };
  }
  // Report the highest matched OR as context; the setup is not named.
  const top = results.sort((x, y) => y.mh.or - x.mh.or || x.id.localeCompare(y.id))[0]!;
  return {
    setupId: null, or: top.mh.or, ci95: top.mh.ci95, p: top.mh.p, n: top.n, label: NO_SUSPECT_LABEL, raw: top.raw,
    reason: `no setup with ≥ ${MIN_MATURE_SESSIONS} mature sessions has a difficulty-matched odds ratio above 1 at p < ${ALPHA}`,
  };
}
