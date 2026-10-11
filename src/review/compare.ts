export type ReviewLike = { setups: { id: string; [metric: string]: unknown }[] };

export type CompareRow = {
  setup: string;
  field: string;
  before: number | null;
  after: number | null;
  delta: number | null;
};

function numericFields(review: ReviewLike): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const s of review.setups) {
    const fields = out.get(s.id) ?? new Map<string, number>();
    for (const [k, v] of Object.entries(s)) {
      if (k !== "id" && typeof v === "number" && Number.isFinite(v)) fields.set(k, v);
    }
    out.set(s.id, fields);
  }
  return out;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function compareReviews(before: ReviewLike, after: ReviewLike): CompareRow[] {
  const b = numericFields(before);
  const a = numericFields(after);
  const rows: CompareRow[] = [];
  for (const setup of new Set([...b.keys(), ...a.keys()])) {
    const bf = b.get(setup);
    const af = a.get(setup);
    const fields = new Set([...(bf?.keys() ?? []), ...(af?.keys() ?? [])]);
    for (const field of fields) {
      const bv = bf?.get(field) ?? null;
      const av = af?.get(field) ?? null;
      const delta = bv === null || av === null ? null : Math.round((av - bv) * 1e4) / 1e4 + 0;
      rows.push({ setup, field, before: bv, after: av, delta });
    }
  }
  return rows.sort((x, y) => cmp(x.setup, y.setup) || cmp(x.field, y.field));
}
