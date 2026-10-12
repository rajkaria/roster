// Derives the forward run's cost comparison from reports/self/forward.json and writes reports/self/forward-cost.json,
// so FACTS can cite it: pairs priced on both sides (excluded rows left out, as in the summary's n), how many the
// promoted (new) setup ran cheaper, and the two median costs per task. Nothing here re-runs or re-grades anything.
//
//   bun scripts/forward-cost.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Row = { task?: unknown; costOld?: unknown; costNew?: unknown; excluded?: unknown };
export type ForwardCost = {
  source: string;
  pairs: number;
  cheaperNew: number;
  medianNewUsd: number | null;
  medianOldUsd: number | null;
  wilcoxonP: number | null;
};

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function forwardCost(forward: { rows?: unknown; cost_p?: unknown }, source = "reports/self/forward.json"): ForwardCost {
  const rows = (Array.isArray(forward.rows) ? forward.rows : []) as Row[];
  const priced = rows.filter((r) => r.excluded === undefined && finite(r.costOld) && finite(r.costNew)) as { costOld: number; costNew: number }[];
  return {
    source,
    pairs: priced.length,
    cheaperNew: priced.filter((r) => r.costNew < r.costOld).length,
    medianNewUsd: median(priced.map((r) => r.costNew)),
    medianOldUsd: median(priced.map((r) => r.costOld)),
    wilcoxonP: finite(forward.cost_p) ? forward.cost_p : null,
  };
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const forward = JSON.parse(readFileSync(join(root, "reports/self/forward.json"), "utf8"));
  const out = forwardCost(forward);
  writeFileSync(join(root, "reports/self/forward-cost.json"), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote reports/self/forward-cost.json: new cheaper in ${out.cheaperNew} of ${out.pairs} pairs`);
}
