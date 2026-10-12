// Data helpers for the landing page. Pure functions over a Review, no React, so tests can import them directly.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Review, SetupRow } from "../lib/types";
import type { BuiltWithData } from "./LandingSections";

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

const readJson = (file: string): unknown => {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  }
};
const HEX32 = /^[0-9a-f]{32}$/;
const httpsOn = (v: unknown, host: string): string | null => {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && (u.hostname === host || u.hostname.endsWith(`.${host}`)) ? v : null;
  } catch {
    return null;
  }
};

/** The "Built with" evidence: the neatlogs before/after trace ids and the cfo.ai share links, from the published reports. */
export function builtWithData(dataDir: string): BuiltWithData {
  const n = readJson(join(dataDir, "self", "neatlogs-before-after.json")) as { before?: { traceId?: unknown }; after?: { traceId?: unknown } } | null;
  const before = n?.before?.traceId;
  const after = n?.after?.traceId;
  const traces = typeof before === "string" && typeof after === "string" && HEX32.test(before) && HEX32.test(after) ? { before, after } : null;
  const c = readJson(join(dataDir, "self", "cfo-plan.json")) as { shareUrls?: { plan?: unknown; book?: unknown } } | null;
  return { traces, cfo: { plan: httpsOn(c?.shareUrls?.plan, "cfo.ai"), book: httpsOn(c?.shareUrls?.book, "cfo.ai") } };
}
