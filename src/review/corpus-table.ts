export type CorpusReview = {
  repo: string;
  sessions: number;
  setups: number;
  costUsd: number | null;
  suspect: string | null;
  replayed: number;
  promoted: string | null;
};

export type CorpusTable = {
  rows: CorpusReview[];
  totals: {
    repos: number;
    sessions: number;
    costUsd: number | null;
    replayed: number;
    promotions: number;
  };
};

export function buildCorpusTable(reviews: CorpusReview[]): CorpusTable {
  const rows = [...reviews].sort(
    (a, b) => b.sessions - a.sessions || (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0),
  );
  const costs = rows.map((r) => r.costUsd).filter((c): c is number => c !== null);
  return {
    rows,
    totals: {
      repos: rows.length,
      sessions: rows.reduce((s, r) => s + r.sessions, 0),
      costUsd: costs.length ? costs.reduce((s, c) => s + c, 0) : null,
      replayed: rows.reduce((s, r) => s + r.replayed, 0),
      promotions: rows.filter((r) => r.promoted !== null).length,
    },
  };
}
