// Forward pair costs, priced from each run's token usage (the same rules as runClaude's provider branch), not from
// the dollar figure Claude Code reports. Used live by runSetupHarness and to re-price recorded pairs from their logs.
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { priceResultEvent } from "../harness/claude.ts";
import type { ResultPrice } from "../harness/claude.ts";

export type RunPrice = ResultPrice & {
  /** False when the run log is missing or holds no result event. */
  found: boolean;
};

/** The last result event in a run log, or null when the log is missing or has none. */
export function lastResultEvent(logPath: string): Record<string, any> | null {
  if (!existsSync(logPath)) return null;
  const lines = readFileSync(logPath, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.includes('"type":"result"')) continue;
    try {
      const j = JSON.parse(lines[i]!);
      if (j?.type === "result") return j;
    } catch {
      /* a line that only mentions the marker is not an event */
    }
  }
  return null;
}

/** Prices one run from its log's last result event, at `at`. A missing log or result is found: false, usd: null. */
export function priceRunLog(logPath: string, at: Date): RunPrice {
  const result = lastResultEvent(logPath);
  if (!result) return { usd: null, model: null, basis: null, found: false };
  return { ...priceResultEvent(result, null, at), found: true };
}

export interface PairCosts {
  task_id: string;
  setup_old: string;
  setup_new: string;
  cost_old: number | null;
  cost_new: number | null;
}

export interface RepriceRow extends PairCosts {
  old: RunPrice;
  new: RunPrice;
  /** The stored costs before the re-price, for the report. */
  before: { cost_old: number | null; cost_new: number | null };
  /** Run logs that were missing; their cost is null. */
  missing: string[];
}

/** The run log of one side of a pair: <runsDir>/<task>.<setup>.jsonl, as scripts/run-setup.sh writes it. */
export const runLogPath = (runsDir: string, taskId: string, setup: string) => join(runsDir, `${taskId}.${setup}.jsonl`);

/**
 * Re-prices every pair from its two run logs. Without `at`, each side is priced at its log's last write, the time the
 * live run priced it (DeepSeek's peak rate depends on the hour). Pure: nothing is written here.
 */
export function repricePairs(pairs: PairCosts[], runsDir: string, at?: Date): RepriceRow[] {
  return pairs.map((p) => {
    const oldLog = runLogPath(runsDir, p.task_id, p.setup_old);
    const newLog = runLogPath(runsDir, p.task_id, p.setup_new);
    const old = priceRunLog(oldLog, at ?? logTime(oldLog));
    const neu = priceRunLog(newLog, at ?? logTime(newLog));
    const missing = [!old.found && oldLog, !neu.found && newLog].filter((x): x is string => typeof x === "string");
    return {
      ...p,
      cost_old: old.usd,
      cost_new: neu.usd,
      old,
      new: neu,
      before: { cost_old: p.cost_old, cost_new: p.cost_new },
      missing,
    };
  });
}

function logTime(path: string): Date {
  return existsSync(path) ? statSync(path).mtime : new Date();
}

/** Writes the re-priced costs of each pair back to forward_pairs. Only cost_old and cost_new change. */
export function writeRepriced(db: Database, rows: RepriceRow[]): void {
  const stmt = db.query("UPDATE forward_pairs SET cost_old = ?, cost_new = ? WHERE task_id = ?");
  for (const r of rows) stmt.run(r.cost_old, r.cost_new, r.task_id);
}
