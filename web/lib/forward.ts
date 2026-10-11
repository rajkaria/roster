// F15: data helpers for the experiment page. The page reads the published forward-run results at
// public/data/self/forward.json (reports/self/forward.json in the repo), and the pre-registration hash at
// public/data/self/prereg.json. `loadForward` is pure over parsed JSON, so tests call it directly; the two
// *File helpers do the disk read and are what the page uses.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One paired task in the forward run, as published. `old` is the demoted setup, `new` the promoted one. */
export interface ForwardRow {
  task: string;
  old: boolean;
  new: boolean;
  costOld: number | null;
  costNew: number | null;
  /** Present when the task was excluded from the comparison, holding the written reason. */
  excluded?: string;
}

export interface ForwardSummary {
  n: number;
  /** The published sentence. The page shows it verbatim, never reworded. */
  wording: string;
  /** Rows loadForward rejected as malformed. They are not in `rows`. */
  skipped: number;
}

export interface Forward {
  rows: ForwardRow[];
  summary: ForwardSummary | null;
}

const DATA = join(process.cwd(), "public", "data");

const object = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** A cost is a finite number, null, or absent (an unpriced task). Anything else makes the row malformed. */
function cost(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v === "number" && Number.isFinite(v)) return { ok: true, value: v };
  return { ok: false };
}

/** A well-formed pair, or null. A row missing its task or its two pass flags is not a pair. */
function row(raw: unknown): ForwardRow | null {
  const r = object(raw);
  if (!r) return null;
  if (typeof r.task !== "string" || r.task.length === 0) return null;
  if (typeof r.old !== "boolean" || typeof r.new !== "boolean") return null;
  const oldCost = cost(r.costOld);
  const newCost = cost(r.costNew);
  if (!oldCost.ok || !newCost.ok) return null;
  if (r.excluded !== undefined && typeof r.excluded !== "string") return null;
  const out: ForwardRow = { task: r.task, old: r.old, new: r.new, costOld: oldCost.value, costNew: newCost.value };
  if (r.excluded !== undefined) out.excluded = r.excluded;
  return out;
}

/** The summary with the skip count added, or null when the file has no usable summary. */
function summary(raw: unknown, skipped: number): ForwardSummary | null {
  const s = object(raw);
  if (!s) return null;
  if (typeof s.n !== "number" || !Number.isFinite(s.n) || typeof s.wording !== "string") return null;
  return { n: s.n, wording: s.wording, skipped };
}

/**
 * Parses a published forward.json. A row that is not a well-formed pair is dropped and counted in
 * `summary.skipped`. A missing or malformed summary gives null, so the page shows the rows without a claim.
 */
export function loadForward(json: unknown): Forward {
  const root = object(json);
  const rawRows = root && Array.isArray(root.rows) ? root.rows : [];
  const rows: ForwardRow[] = [];
  let skipped = 0;
  for (const raw of rawRows) {
    const normalized = row(raw);
    if (normalized) rows.push(normalized);
    else skipped++;
  }
  return { rows, summary: summary(root?.summary, skipped) };
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** The forward results under dataDir (default public/data), or null when the file is absent or unreadable. */
export function loadForwardFile(dataDir: string = DATA): Forward | null {
  const json = readJson(join(dataDir, "self", "forward.json"));
  return json === undefined ? null : loadForward(json);
}

const SHA256 = /^[0-9a-f]{64}$/i;
/** Keys the harness may publish the frozen backlog's hash under. Only a 64-hex value is ever shown. */
const SHA_KEYS = ["backlog_sha256", "backlogSha256", "sha256"] as const;

/**
 * The frozen backlog's sha256 from a prereg.json, or null. A value that is not a 64-hex string under a
 * recognised key is ignored, so a stray hash is never published as the backlog's.
 */
export function loadPrereg(json: unknown): string | null {
  const root = object(json);
  if (!root) return null;
  const nested = object(root.backlog);
  for (const key of SHA_KEYS) {
    const v = root[key] ?? nested?.[key];
    if (typeof v === "string" && SHA256.test(v)) return v.toLowerCase();
  }
  return null;
}

/** The frozen backlog's sha256 from prereg.json under dataDir, or null when it is absent or has no hash. */
export function loadPreregFile(dataDir: string = DATA): string | null {
  const json = readJson(join(dataDir, "self", "prereg.json"));
  return json === undefined ? null : loadPrereg(json);
}
