export type CostRow = { setup: string; costUsd: number | null };

export type CostStats = {
  setup: string;
  n: number;
  nullCount: number;
  totalUsd: number;
  meanUsd: number | null;
  p50Usd: number | null;
  p90Usd: number | null;
};

const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;

// Nearest-rank percentile on an ascending-sorted, non-empty array.
function nearestRank(sorted: number[], p: number): number {
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1]!;
}

/** Per-setup cost totals and spread. `n` counts non-null costs; nulls go to `nullCount`. */
export function costStats(rows: CostRow[]): CostStats[] {
  const bySetup = new Map<string, { values: number[]; nullCount: number }>();
  for (const r of rows) {
    let g = bySetup.get(r.setup);
    if (!g) bySetup.set(r.setup, (g = { values: [], nullCount: 0 }));
    if (r.costUsd === null || !Number.isFinite(r.costUsd)) g.nullCount++;
    else g.values.push(r.costUsd);
  }
  return [...bySetup.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((setup) => {
      const { values, nullCount } = bySetup.get(setup)!;
      const sorted = [...values].sort((a, b) => a - b);
      const total = sorted.reduce((s, v) => s + v, 0);
      const n = sorted.length;
      return {
        setup,
        n,
        nullCount,
        totalUsd: round4(total),
        meanUsd: n ? round4(total / n) : null,
        p50Usd: n ? round4(nearestRank(sorted, 0.5)) : null,
        p90Usd: n ? round4(nearestRank(sorted, 0.9)) : null,
      };
    });
}
