#!/usr/bin/env bun
// Re-prices every recorded forward pair from its run logs (.roster/runs/<task>.<setup>.jsonl, the last result event)
// and writes cost_old / cost_new back to forward_pairs. A missing log leaves its cost null and is listed.
//
//   bun scripts/reprice-forward.ts [--db <path>] [--runs <dir>] [--dry-run]
//
// --db    the forward database (default: .roster/roster.db, relative to the repo root)
// --runs  the run-log directory (default: .roster/runs under the repo root)
// --dry-run  prints the report and writes nothing
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { repricePairs, writeRepriced } from "../src/forward/cost.ts";
import type { PairCosts, RepriceRow, RunPrice } from "../src/forward/cost.ts";
import { DEFAULT_FORWARD_DB } from "../src/forward/index.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} needs a value`);
  return v;
};
const dryRun = args.includes("--dry-run");
const repo = resolve(import.meta.dir, "..");
const dbPath = resolve(flag("--db") ?? resolve(repo, DEFAULT_FORWARD_DB));
const runsDir = resolve(flag("--runs") ?? resolve(repo, ".roster", "runs"));

if (!existsSync(dbPath)) {
  console.error(`reprice-forward: no forward database at ${dbPath}`);
  process.exit(1);
}

const read = new Database(dbPath, { readonly: true });
const pairs = read.query("SELECT task_id, setup_old, setup_new, cost_old, cost_new FROM forward_pairs ORDER BY seq").all() as PairCosts[];
read.close();

const rows = repricePairs(pairs, runsDir);

const money = (v: number | null) => (v === null ? "null" : `$${v.toFixed(6)}`);
const basis = (p: RunPrice) => p.basis ?? (p.found ? "unpriced" : "missing log");
const line = (r: RepriceRow) =>
  `${r.task_id} ${r.setup_old}/${r.setup_new}  old ${money(r.before.cost_old)} -> ${money(r.cost_old)}  ` +
  `new ${money(r.before.cost_new)} -> ${money(r.cost_new)}  basis old=${basis(r.old)} new=${basis(r.new)}`;

for (const r of rows) console.log(line(r));
const missing = [...new Set(rows.flatMap((r) => r.missing))];
for (const m of missing) console.log(`missing log: ${m}`);

if (dryRun) {
  console.log(`dry run: ${rows.length} pairs, nothing written`);
} else {
  const write = new Database(dbPath);
  writeRepriced(write, rows);
  write.close();
  console.log(`wrote ${rows.length} pairs to ${dbPath}`);
}
