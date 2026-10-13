// Cross-repo view of live reviews (post-deadline): every setup of every live-reviewed repo, grouped by model.
// Descriptive only: level A, observational, and the repos' tasks differ. Pure, so tests import it directly.

export interface SetupSummary {
  model: string | null;
  sessions: number;
  mature_sessions: number;
  spend_usd: number | null;
  survival: number | null;
  surviving_changes?: number | null;
}

export interface ModelRow {
  model: string;
  repos: number;
  sessions: number;
  mature_sessions: number;
  /** Mean survival over setups that have one, weighted by their mature sessions. */
  survival: number | null;
  /** Spend of the setups whose sessions are all priced. */
  priced_spend: number | null;
  /** Priced spend over surviving changes, for setups with both. */
  cost_per_surviving_change: number | null;
}

/**
 * One key per model: "claude-opus-4-6[1m]", "anthropic.claude-opus-4-6" and "us.anthropic.claude-opus-4-6-v1:0" are
 * all "claude-opus-4-6". A missing model is "unknown".
 */
export function modelKey(model: string | null): string {
  const m = (model ?? "")
    .trim()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/^(?:[a-z]{2}\.)?(?:anthropic|openai|google|meta|mistral|deepseek)\./i, "")
    .replace(/-v\d+:\d+$/, "");
  return m || "unknown";
}

export function byModel(entries: { repo: string; setups: SetupSummary[] }[]): ModelRow[] {
  const acc = new Map<string, { repos: Set<string>; sessions: number; mature: number; survW: number; survN: number; spend: number; priced: boolean; costSpend: number; surviving: number }>();
  for (const e of entries) {
    for (const s of e.setups) {
      const k = modelKey(s.model);
      const a = acc.get(k) ?? { repos: new Set(), sessions: 0, mature: 0, survW: 0, survN: 0, spend: 0, priced: false, costSpend: 0, surviving: 0 };
      a.repos.add(e.repo);
      a.sessions += s.sessions;
      a.mature += s.mature_sessions;
      if (s.survival !== null && s.mature_sessions > 0) {
        a.survW += s.survival * s.mature_sessions;
        a.survN += s.mature_sessions;
      }
      if (s.spend_usd !== null) {
        a.spend += s.spend_usd;
        a.priced = true;
        if ((s.surviving_changes ?? 0) > 0) {
          a.costSpend += s.spend_usd;
          a.surviving += s.surviving_changes!;
        }
      }
      acc.set(k, a);
    }
  }
  return [...acc]
    .map(([model, a]) => ({
      model,
      repos: a.repos.size,
      sessions: a.sessions,
      mature_sessions: a.mature,
      survival: a.survN > 0 ? a.survW / a.survN : null,
      priced_spend: a.priced ? a.spend : null,
      cost_per_surviving_change: a.surviving > 0 ? a.costSpend / a.surviving : null,
    }))
    .sort((x, y) => y.sessions - x.sessions || x.model.localeCompare(y.model));
}
