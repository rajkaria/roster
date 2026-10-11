// Existing-setup candidates (DESIGN.md §"Plan (coordinator)").
//
//   const ids = rankExisting(setups, suspect, 3);
//   ids;   // up to three setups from the team's own roster, best replacement first
//
// A suspect is replaced by a setup the team already runs, so the candidate set is the roster itself. The
// suspect is excluded (it is the thing being replaced), as are setups with fewer than three sessions: below
// that the bad rate is noise, and DESIGN.md §"Suspect" already refuses to call a setup suspect without
// enough mature sessions. Ordering is by bad rate ascending — a replacement should fail less often — then by
// cost per session ascending, then by id so the output is deterministic for a given input. A null bad rate or
// cost sorts last in its key: an unknown number is never evidence that a setup is better or cheaper. The
// input array is not mutated.

export interface ExistingSetup {
  id: string;
  /** Share of mature sessions that went bad, or null when unknown. */
  badRate: number | null;
  /** Mature sessions observed for this setup. */
  sessions: number;
  /** Mean USD per session, or null when unpriced. */
  costPerSession: number | null;
}

/** Minimum sessions a setup needs before it can be ranked. */
export const MIN_SESSIONS = 3;

/** Nulls sort after every number in the same key. */
function compareNullable(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/**
 * Ranks the team's existing setups as replacements for `suspect`, best first. Returns at most `max` ids.
 */
export function rankExisting(setups: ExistingSetup[], suspect: string, max: number): string[] {
  if (max <= 0) return [];

  const eligible = setups.filter((s) => s.id !== suspect && s.sessions >= MIN_SESSIONS);

  eligible.sort((a, b) => {
    const byBad = compareNullable(a.badRate, b.badRate);
    if (byBad !== 0) return byBad;
    const byCost = compareNullable(a.costPerSession, b.costPerSession);
    if (byCost !== 0) return byCost;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return eligible.slice(0, max).map((s) => s.id);
}
