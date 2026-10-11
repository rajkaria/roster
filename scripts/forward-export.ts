// T72: exports the forward run (DESIGN.md §"Forward run") from its database into the files the experiment page
// (web/lib/forward.ts) and docs/FACTS.md (scripts/facts.ts) read: reports/self/forward.json and reports/self/prereg.json.
// The database is opened read-only; this script never writes to .roster/.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { forwardSummary } from "../src/forward/analysis.ts";
import type { ForwardAnalysisPair, ForwardSummary } from "../src/forward/analysis.ts";

export const DEFAULT_DB = ".roster/forward.db";
export const DEFAULT_EXCLUSIONS = "reports/self/forward-exclusions.json";
export const DEFAULT_FREEZE = "experiments/FREEZE.txt";
export const DEFAULT_OUT = "reports/self";

/** The columns of forward_pairs this export reads. merged_reason and secondary are absent on pre-amendment-8 databases. */
export interface ExportPair {
  task: string;
  passOld: boolean;
  passNew: boolean;
  costOld: number | null;
  costNew: number | null;
  merged: "old" | "new" | null;
  mergedReason: string | null;
  secondary: string | null;
  seq: number;
}

export interface Exclusion {
  task: string;
  reason: string;
  amendment?: number;
}

/** Every recorded pair, in seq order (wave-A rows carry seq < 0, so they come first). Opens the file read-only. */
export function readPairs(dbPath: string): ExportPair[] {
  if (!existsSync(dbPath)) throw new Error(`forward-export: no database at ${dbPath}`);
  const db = new Database(dbPath, { readonly: true });
  try {
    const have = new Set((db.query("PRAGMA table_info(forward_pairs)").all() as { name: string }[]).map((c) => c.name));
    if (have.size === 0) throw new Error(`forward-export: ${dbPath} has no forward_pairs table`);
    const opt = (col: string) => (have.has(col) ? col : `NULL AS ${col}`);
    const rows = db
      .query(`SELECT task_id, pass_old, pass_new, cost_old, cost_new, merged, seq, ${opt("merged_reason")}, ${opt("secondary")} FROM forward_pairs ORDER BY seq, task_id`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      task: r.task_id as string,
      passOld: r.pass_old === 1,
      passNew: r.pass_new === 1,
      costOld: (r.cost_old ?? null) as number | null,
      costNew: (r.cost_new ?? null) as number | null,
      merged: (r.merged ?? null) as "old" | "new" | null,
      mergedReason: (r.merged_reason ?? null) as string | null,
      secondary: (r.secondary ?? null) as string | null,
      seq: r.seq as number,
    }));
  } finally {
    db.close();
  }
}

/** The exclusions in reports/self/forward-exclusions.json; none when the file is absent. */
export function readExclusions(path: string): Exclusion[] {
  if (!existsSync(path)) return [];
  const json = JSON.parse(readFileSync(path, "utf8")) as { exclusions?: unknown };
  if (!Array.isArray(json.exclusions)) throw new Error(`forward-export: ${path} has no exclusions array`);
  return json.exclusions.map((e: any) => {
    if (typeof e?.task !== "string" || typeof e?.reason !== "string") throw new Error(`forward-export: malformed exclusion in ${path}`);
    return { task: e.task, reason: e.reason, ...(typeof e.amendment === "number" ? { amendment: e.amendment } : {}) };
  });
}

export interface ForwardRowOut {
  task: string;
  old: boolean;
  new: boolean;
  costOld: number | null;
  costNew: number | null;
  excluded?: string;
  merged: "old" | "new" | null;
}

export interface ForwardReport {
  schemaVersion: 1;
  /** Read by web/lib/forward.ts. */
  rows: ForwardRowOut[];
  summary: ForwardSummary;
  /** Read by scripts/facts.ts (FORWARD_*). */
  pairs: { n: number; recorded: number; excluded: number };
  mcnemar: { new_only: number; old_only: number; both: number; neither: number; p: number };
  wording: string;
  /** Wilcoxon p on costNew - costOld over the counted pairs, with costs as stored (re-priced). */
  cost_p: number | null;
  /** Amendment 18's sensitivity analysis: amendment 18's exclusions counted as recorded; null when it has none. */
  sensitivity: ForwardSummary | null;
  /** Exploratory secondary outcome (amendment 8) over the counted pairs; never H1. `unrecorded` is a null field. */
  secondary: { old: number; new: number; tie: number; none: number; unrecorded: number };
  /** Pairs whose merged_reason contains "build-only". Build-only merges are excluded from every comparison. */
  build_only_merges: number;
  /** Exclusions naming a task with no recorded pair. */
  unmatched_exclusions: string[];
}

/** The forward report: H1 over pass_old/pass_new, exclusions applied, secondary outcomes counted separately. */
export function buildForwardReport(pairs: ExportPair[], exclusions: Exclusion[]): ForwardReport {
  const reasons = new Map<string, Exclusion>();
  for (const e of exclusions) if (!reasons.has(e.task)) reasons.set(e.task, e);
  const analysis = (skip: (e: Exclusion) => boolean): ForwardAnalysisPair[] =>
    pairs.map((p) => {
      const e = reasons.get(p.task);
      const out: ForwardAnalysisPair = { task: p.task, passOld: p.passOld, passNew: p.passNew, costOld: p.costOld, costNew: p.costNew };
      if (e && !skip(e)) out.excluded = e.reason;
      return out;
    });

  const summary = forwardSummary(analysis(() => false));
  const hasA18 = pairs.some((p) => reasons.get(p.task)?.amendment === 18);
  const sensitivity = hasA18 ? forwardSummary(analysis((e) => e.amendment === 18)) : null;

  const rows: ForwardRowOut[] = pairs.map((p) => {
    const e = reasons.get(p.task);
    return { task: p.task, old: p.passOld, new: p.passNew, costOld: p.costOld, costNew: p.costNew, ...(e ? { excluded: e.reason } : {}), merged: p.merged };
  });

  const secondary = { old: 0, new: 0, tie: 0, none: 0, unrecorded: 0 };
  for (const p of pairs) {
    if (reasons.has(p.task)) continue;
    const s = p.secondary;
    if (s === "old" || s === "new" || s === "tie" || s === "none") secondary[s]++;
    else secondary.unrecorded++;
  }

  const recorded = new Set(pairs.map((p) => p.task));
  return {
    schemaVersion: 1,
    rows,
    summary,
    pairs: { n: summary.n, recorded: pairs.length, excluded: summary.excludedCount },
    mcnemar: { new_only: summary.newOnly, old_only: summary.oldOnly, both: summary.both, neither: summary.neither, p: summary.p },
    wording: summary.wording,
    cost_p: summary.costP,
    sensitivity,
    secondary,
    build_only_merges: pairs.filter((p) => p.mergedReason?.toLowerCase().includes("build-only")).length,
    unmatched_exclusions: [...reasons.keys()].filter((t) => !recorded.has(t)).sort(),
  };
}

/** The two hashes in experiments/FREEZE.txt. Throws when either is missing, so a stray hash is never published. */
export function parseFreeze(text: string): { backlogSha256: string; acceptanceSha256: string } {
  const backlog = /^forward-backlog\.md\s+sha256\s+([0-9a-f]{64})\s*$/m.exec(text)?.[1];
  const acceptance = /^acceptance tests\b.*\bsha256\s+([0-9a-f]{64})\s*$/m.exec(text)?.[1];
  if (!backlog || !acceptance) throw new Error("forward-export: FREEZE.txt lacks the backlog or acceptance sha256");
  return { backlogSha256: backlog, acceptanceSha256: acceptance };
}

export interface ExportOptions {
  db?: string;
  exclusions?: string;
  freeze?: string;
  out?: string;
}

/** Reads the database and writes forward.json and prereg.json under `out`. Returns the forward report. */
export function exportForward(opts: ExportOptions = {}): ForwardReport {
  const out = opts.out ?? DEFAULT_OUT;
  const report = buildForwardReport(readPairs(opts.db ?? DEFAULT_DB), readExclusions(opts.exclusions ?? DEFAULT_EXCLUSIONS));
  const prereg = parseFreeze(readFileSync(opts.freeze ?? DEFAULT_FREEZE, "utf8"));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "forward.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(out, "prereg.json"), JSON.stringify(prereg, null, 2) + "\n");
  return report;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const out = flag("out") ?? DEFAULT_OUT;
  const report = exportForward({ db: flag("db"), exclusions: flag("exclusions"), freeze: flag("freeze"), out });
  console.log(`wrote ${join(out, "forward.json")} and ${join(out, "prereg.json")}: ${report.wording}`);
  if (report.unmatched_exclusions.length) console.log(`exclusions with no recorded pair: ${report.unmatched_exclusions.join(", ")}`);
}
