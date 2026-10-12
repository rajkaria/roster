// The /book page's data helper. It reads the AI-workforce book that `roster book --write` publishes to
// reports/self/book.json (the prebuild copies reports/ into public/data). Money arrives in USD and shares
// arrive in [0, 1]; the page shows "$1,234.56" and "42.0%". A missing or unreadable file is an empty state.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One row of the department table, already formatted for display. */
export interface BookRow {
  setup: string;
  label: string;
  monthly: string;
  perChange: string;
  unattended: string;
}

export interface Book {
  rows: BookRow[];
  scenario: { hire: string; scale: string } | null;
  shareUrl: string | null;
}

/** The empty state: no book.json published yet. */
export const emptyBook = (): Book => ({ rows: [], scenario: null, shareUrl: null });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Money, two decimals with thousands separators: 1234.56 -> "$1,234.56". Missing or non-numeric is "n/a". */
export const money = (v: unknown): string =>
  typeof v === "number" && Number.isFinite(v)
    ? `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "n/a";

/** A share in [0, 1] becomes a percent: 0.42 -> "42.0%". A value above 1 is already a percent. Else "n/a". */
export const percent = (v: unknown): string => {
  if (typeof v !== "number" || !Number.isFinite(v)) return "n/a";
  return `${(Math.abs(v) <= 1 ? v * 100 : v).toFixed(1)}%`;
};

/** The unattended figure: a yes/no flag, a share, an already-computed percent, or "n/a". */
const unattendedText = (v: unknown): string => {
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (text(v)) return v as string;
  return percent(v);
};

const firstArray = (...vals: unknown[]): unknown[] => {
  for (const v of vals) if (Array.isArray(v)) return v;
  return [];
};

/** One formatted row, keyed as the page reads it or as src/cfo/book.ts writes the department. */
function rowOf(raw: Record<string, unknown>): BookRow {
  const setup = text(raw.setup) ?? text(raw.setup_id) ?? "";
  // The builder calls cost per surviving change money (costPerSurvivingChangeUsd); a page-shaped book may
  // instead carry `perChange` as a share, which reads as a percent. Each key keeps its own meaning.
  const perChange = raw.perChange !== undefined ? percent(raw.perChange) : money(raw.costPerSurvivingChangeUsd);
  return {
    setup,
    label: text(raw.label) ?? setup,
    monthly: money(raw.monthly ?? raw.monthlySpendUsd ?? raw.spend_usd),
    perChange,
    unattended: unattendedText(raw.unattended ?? raw.unattendedPct),
  };
}

function scenarioOf(v: unknown): Book["scenario"] {
  if (!isRecord(v)) return null;
  return { hire: money(v.hire ?? v.hireMonthlyUsd), scale: money(v.scale ?? v.scaleMonthlyUsd) };
}

/** The book's share link, kept only when it is an https URL on cfo.ai. Anything else is null. */
export function shareUrlOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:") return null;
  if (host !== "cfo.ai" && !host.endsWith(".cfo.ai")) return null;
  return v;
}

/** Accepts a parsed book.json. Anything else (null, a string, an array) gives the empty state. */
export function loadBook(json: unknown): Book {
  if (!isRecord(json)) return emptyBook();
  const rows = firstArray(json.rows, json.department, json.setups)
    .filter(isRecord)
    .map(rowOf);
  return { rows, scenario: scenarioOf(json.scenario), shareUrl: shareUrlOf(json.shareUrl) };
}

/** Where the book lands in the web data dir: reports/self/book.json -> public/data/self/book.json. */
export const bookPath = (dataDir: string): string => join(dataDir, "self", "book.json");

/** loadBook over public/data/self/book.json. Absent, unreadable or malformed JSON is the empty state. */
export function loadBookFromData(dataDir: string = join(process.cwd(), "public", "data")): Book {
  const file = bookPath(dataDir);
  if (!existsSync(file)) return emptyBook();
  try {
    return loadBook(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return emptyBook();
  }
}

/** The book's context for its labels: the session window it scales (days, 2 decimals) and the assumed sessions a week. Null when absent. */
export function bookContext(dataDir: string): { periodDays: string | null; sessionsPerWeek: number | null } {
  const file = join(dataDir, "self", "book.json");
  let json: unknown = null;
  try {
    json = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch {
    json = null;
  }
  const r = (isRecord(json) ? json : {}) as { period?: { days?: unknown }; assumptions?: { scaleSessionsPerWeek?: unknown } };
  const fin = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const days = fin(r.period?.days);
  return { periodDays: days === null ? null : days.toFixed(2), sessionsPerWeek: fin(r.assumptions?.scaleSessionsPerWeek) };
}
