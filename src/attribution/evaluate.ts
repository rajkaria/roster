// Attribution accuracy (DESIGN.md §"Ingest", "setup inference matches the prompt tags in ≥ 95% of
// sessions"): how often a prediction names the right session or setup. Pure scoring helpers — the
// callers supply the predictions, the key and the tagged rows.

/** One predicted label for an item the key also holds. */
export interface AttributionPrediction {
  id: string;
  predicted: string;
}

/** Ground truth for one item. */
export interface AttributionKeyEntry {
  id: string;
  actual: string;
}

export interface AttributionAccuracy {
  correct: number;
  total: number;
  /** correct / total, rounded to 4 decimals; 0 when total is 0. */
  accuracy: number;
  /** Key ids no prediction covers, in key order. */
  missing: string[];
}

/** One session as the setup tagger saw it: an inferred cluster (or none) and a ground-truth tag (or none). */
export interface TagAccuracyRow {
  inferredSetup: string | null;
  tag: string | null;
}

export interface TagAccuracy {
  correct: number;
  total: number;
  /** correct / total, rounded to 4 decimals; 0 when total is 0. */
  accuracy: number;
}

/** Rounded to 4 decimals so the scorecard is stable across runs. */
const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** Accuracy is 0 when there is nothing to score, never NaN. */
const ratio = (correct: number, total: number) => (total === 0 ? 0 : round4(correct / total));

/**
 * Share of key entries the predictions got right. The key decides the denominator: a key id with no
 * prediction is wrong and is listed in `missing`; a prediction with no key entry is ignored.
 */
export function attributionAccuracy(
  pred: ReadonlyArray<AttributionPrediction>,
  key: ReadonlyArray<AttributionKeyEntry>,
): AttributionAccuracy {
  // A repeated id keeps its last prediction, so the map matches what a caller reading pred in order would see.
  const byId = new Map<string, string>();
  for (const p of pred) byId.set(p.id, p.predicted);
  let correct = 0;
  const missing: string[] = [];
  for (const k of key) {
    const predicted = byId.get(k.id);
    if (predicted === undefined) missing.push(k.id);
    else if (predicted === k.actual) correct++;
  }
  return { correct, total: key.length, accuracy: ratio(correct, key.length), missing };
}

/** The single most frequent value, or null when the top count is tied. */
function majority(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let top = 0;
  let tied = false;
  for (const [value, n] of counts) {
    if (n > top) {
      best = value;
      top = n;
      tied = false;
    } else if (n === top) {
      tied = true;
    }
  }
  return tied ? null : best;
}

/**
 * Share of tagged rows whose inferred cluster names their tag. Only tagged rows count. Each inferred
 * cluster first takes the tag it most often carries (a tie names no tag), then every tagged row is
 * compared against its cluster's tag. A row with no inferred setup belongs to no cluster, so it is
 * wrong — abstaining never counts as naming the right setup.
 */
export function tagAccuracy(rows: ReadonlyArray<TagAccuracyRow>): TagAccuracy {
  const tagged = rows.flatMap((r) => (r.tag === null ? [] : [{ inferredSetup: r.inferredSetup, tag: r.tag }]));
  const total = tagged.length;
  if (total === 0) return { correct: 0, total: 0, accuracy: 0 };
  const counts = new Map<string, Map<string, number>>();
  for (const r of tagged) {
    if (r.inferredSetup === null) continue;
    const byTag = counts.get(r.inferredSetup) ?? new Map<string, number>();
    byTag.set(r.tag, (byTag.get(r.tag) ?? 0) + 1);
    counts.set(r.inferredSetup, byTag);
  }
  const clusterTag = new Map<string, string | null>();
  for (const [id, byTag] of counts) clusterTag.set(id, majority(byTag));
  const correct = tagged.filter((r) => r.inferredSetup !== null && clusterTag.get(r.inferredSetup) === r.tag).length;
  return { correct, total, accuracy: ratio(correct, total) };
}
