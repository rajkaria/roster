// Collects every measured run cost from the reports into reports/costs.json.
// Sources: replays.json (data[].costUsd), forward.json (data.pairs[] costOld/costNew), review.json (data.setups[].costUsd).
// Unknown files are ignored; malformed entries are skipped and not counted.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export type CostRow = { source: string; setup: string; costUsd: number | null };
export type CostSummary = { reviewRuns: number; replayRuns: number; forwardRuns: number; rows: CostRow[] };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The report body: `json.data` when the file wraps it, else the json itself. */
const body = (json: unknown): unknown => (isRecord(json) && "data" in json ? json.data : json);

/** A cost is a finite number or null; anything else (including absent) is malformed. */
const validCost = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v));
const validSetup = (v: unknown): v is string => typeof v === "string" && v !== "";

const pick = (o: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (k in o) return o[k];
  return undefined;
};

export function collectCosts(files: { path: string; json: unknown }[]): CostSummary {
  const rows: CostRow[] = [];
  let reviewRuns = 0;
  let replayRuns = 0;
  let forwardRuns = 0;

  const add = (source: string, setup: unknown, cost: unknown): boolean => {
    if (!validSetup(setup) || !validCost(cost)) return false;
    rows.push({ source, setup, costUsd: cost });
    return true;
  };

  for (const f of files) {
    const name = basename(f.path);
    const data = body(f.json);
    if (name === "replays.json") {
      if (!Array.isArray(data)) continue;
      for (const e of data) {
        if (isRecord(e) && add(f.path, pick(e, "setup", "setupId", "setup_id"), e.costUsd)) replayRuns++;
      }
    } else if (name === "forward.json") {
      if (!isRecord(data) || !Array.isArray(data.pairs)) continue;
      for (const p of data.pairs) {
        if (!isRecord(p)) continue;
        if (add(f.path, pick(p, "setupOld", "setup_old"), p.costOld)) forwardRuns++;
        if (add(f.path, pick(p, "setupNew", "setup_new"), p.costNew)) forwardRuns++;
      }
    } else if (name === "review.json") {
      if (!isRecord(data) || !Array.isArray(data.setups)) continue;
      for (const s of data.setups) {
        if (isRecord(s) && add(f.path, pick(s, "setup", "setupId", "setup_id"), s.costUsd)) reviewRuns++;
      }
    }
  }
  return { reviewRuns, replayRuns, forwardRuns, rows };
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

if (import.meta.main) {
  const dir = process.argv[2] ?? "reports";
  const files: { path: string; json: unknown }[] = [];
  for (const path of walk(dir).sort()) {
    if (!path.endsWith(".json") || basename(path) === "costs.json") continue;
    try {
      files.push({ path, json: JSON.parse(readFileSync(path, "utf8")) });
    } catch {
      // unreadable or non-JSON file: ignored
    }
  }
  const out = collectCosts(files);
  writeFileSync(join(dir, "costs.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`costs.json: ${out.reviewRuns} review, ${out.replayRuns} replay, ${out.forwardRuns} forward rows`);
}
