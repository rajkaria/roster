// Data helpers for the landing page. Pure functions over a Review, no React, so tests can import them directly.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Review, SetupRow } from "../lib/types";

/** The repo whose own review the landing page shows. */
export const SELF_OWNER = "rajkaria";
export const SELF_REPO = "roster";
export const GITHUB = `https://github.com/${SELF_OWNER}/${SELF_REPO}`;

export interface LandingRow {
  setup_id: string;
  label: string;
  sessions: number;
  spend: string;
  unattended: string;
}

/** An unknown spend is never shown as $0; a lower bound reads "≥ $x". */
export function formatSpend(usd: number | null, lowerBound: boolean, priced: number, sessions: number): string {
  if (usd === null) return `unknown (${priced}/${sessions} priced)`;
  return `${lowerBound ? "≥ " : ""}$${usd.toFixed(2)}`;
}

/** A setup with no mature session has no rate yet: it reads "too young", not 0%. */
export function formatUnattended(s: SetupRow): string {
  if (s.mature_sessions === 0) return "too young";
  return s.unattended === null ? "n/a" : `${Math.round(s.unattended * 100)}%`;
}

export function landingRows(review: Review): LandingRow[] {
  return review.setups.map((s) => ({
    setup_id: s.setup_id,
    label: s.label,
    sessions: s.sessions,
    spend: formatSpend(s.spend_usd, s.spend_lower_bound ?? false, s.priced_sessions ?? 0, s.sessions),
    unattended: formatUnattended(s),
  }));
}

/** Totals across setups. Spend is unknown if any setup's spend is unknown, and a lower bound if any setup's is. */
export function landingTotals(review: Review): { sessions: number; spend: string } {
  const sessions = review.setups.reduce((n, s) => n + s.sessions, 0);
  const priced = review.setups.reduce((n, s) => n + (s.priced_sessions ?? (s.spend_usd === null ? 0 : s.sessions)), 0);
  const unknown = review.setups.some((s) => s.spend_usd === null);
  const usd = unknown ? null : review.setups.reduce((n, s) => n + (s.spend_usd ?? 0), 0);
  const lower = review.setups.some((s) => s.spend_lower_bound === true);
  return { sessions, spend: formatSpend(usd, lower, priced, sessions) };
}

/** The forward run counts as started once its results file is published. */
export function forwardStarted(dataDir: string): boolean {
  return existsSync(join(dataDir, "self", "forward.json"));
}
