// Forward-run analysis (DESIGN.md §"Forward run"): the exact McNemar test on the paired pass/fail outcomes,
// the Wilcoxon signed-rank test on the paired costs, and the wording of the claim. Every rule here is
// pre-registered in the backlog task F09, so the numbers a report prints are the ones the run promised.
// Statistics live in experiments/, not in the repo's own evidence: nothing in this file feeds docs/FACTS.md.

/** A forward run may claim a result only from this many counted pairs on. */
export const MIN_CLAIM_PAIRS = 24;
/** Significance level for both tests. */
export const ALPHA = 0.05;

// ---- McNemar exact ----

/**
 * Two-sided exact McNemar test over the discordant counts `b` and `c`.
 * Under the null every discordant pair falls either way with p = 1/2, so the exact two-sided p is
 * `2 * sum_{k <= min(b, c)} C(b + c, k) * 2^-(b + c)`, capped at 1. No discordant pairs means no evidence,
 * so p = 1; the result is symmetric in `b` and `c`.
 */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n <= 0) return 1;
  const k = Math.min(b, c);
  // Sum the tail in log space: C(n, k) * 2^-n overflows a double for large n even when the tail is negligible.
  let logSum = -Infinity;
  let logTerm = -n * Math.LN2; // C(n, 0) * 2^-n
  for (let i = 0; i <= k; i++) {
    if (i > 0) logTerm += Math.log((n - i + 1) / i); // C(n, i) = C(n, i - 1) * (n - i + 1) / i
    logSum = logSum === -Infinity ? logTerm : logAdd(logSum, logTerm);
  }
  return Math.min(1, 2 * Math.exp(logSum));
}

/** log(e^a + e^b) without overflowing. */
function logAdd(a: number, b: number): number {
  const m = Math.max(a, b);
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

// ---- Wilcoxon signed-rank ----

export interface WilcoxonResult {
  /** Sum of the ranks of the positive differences. */
  w: number;
  /** Two-sided p-value. */
  p: number;
  /** Number of non-zero differences. */
  n: number;
}

/**
 * Two-sided Wilcoxon signed-rank test on the paired differences.
 * Zero differences are dropped from both n and the ranks (they carry no sign); tied absolute differences
 * share their average rank. The exact null distribution is used for n <= 20, the normal approximation
 * (continuity corrected) for n > 20. Fewer than one non-zero difference means no evidence, so p = 1.
 */
export function wilcoxonSignedRank(diffs: number[]): WilcoxonResult {
  const nonZero = diffs.filter((d) => d !== 0);
  const n = nonZero.length;
  if (n === 0) return { w: 0, p: 1, n: 0 };
  const ranks = averageRanks(nonZero.map((d) => Math.abs(d)));
  const w = nonZero.reduce((sum, d, i) => (d > 0 ? sum + ranks[i]! : sum), 0);
  return { w, p: n <= 20 ? exactP(ranks, w, n) : normalP(ranks, w, n), n };
}

/** 1-based ranks of `values`, ties sharing their average rank. */
function averageRanks(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length).fill(0);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]!.v === order[i]!.v) j++;
    const avg = (i + 1 + (j + 1)) / 2; // ranks i + 1 .. j + 1
    for (let k = i; k <= j; k++) ranks[order[k]!.i] = avg;
    i = j + 1;
  }
  return ranks;
}

/** Exact two-sided p: the null distribution of the positive-rank sum over all 2^n sign assignments. */
function exactP(ranks: number[], w: number, n: number): number {
  // Halved ranks (what ties produce) are doubled to make the subset sums integers.
  const scaled = ranks.map((r) => Math.round(r * 2));
  const total = scaled.reduce((a, b) => a + b, 0);
  const counts = new Float64Array(total + 1);
  counts[0] = 1;
  let reach = 0;
  for (const r of scaled) {
    for (let s = reach; s >= 0; s--) {
      const c = counts[s]!;
      if (c !== 0) counts[s + r] = counts[s + r]! + c;
    }
    reach += r;
  }
  const target = Math.round(w * 2);
  let low = 0;
  for (let s = 0; s <= target; s++) low += counts[s]!;
  let high = 0;
  for (let s = target; s <= total; s++) high += counts[s]!;
  return Math.min(1, (2 * Math.min(low, high)) / 2 ** n);
}

/** Normal approximation: continuity correction to the sum, standard tie correction to the variance. */
function normalP(ranks: number[], w: number, n: number): number {
  const mean = (n * (n + 1)) / 4;
  let tieSum = 0;
  for (let i = 0; i < ranks.length; ) {
    let j = i;
    while (j + 1 < ranks.length && ranks[j + 1] === ranks[i]) j++;
    tieSum += (j - i + 1) ** 3 - (j - i + 1);
    i = j + 1;
  }
  const variance = (n * (n + 1) * (2 * n + 1)) / 24 - tieSum / 48;
  if (variance <= 0) return 1;
  const z = Math.max(0, Math.abs(w - mean) - 0.5) / Math.sqrt(variance);
  return Math.min(1, 2 * (1 - normalCdf(z)));
}

/** Standard normal CDF, for the n > 20 branch. Exported so tests can check it against published values. */
export function normalCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2);
}

/** Complementary error function, Chebyshev form (Numerical Recipes, §6.2). */
function erfc(x: number): number {
  return x >= 0 ? erfcPositive(x) : 2 - erfcPositive(-x);
}

const ERFC_COF = [
  -1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2, -9.561514786808631e-3, -9.46595344482036e-4, 3.66839497852761e-4,
  4.2523324806907e-5, -2.0278578112534e-5, -1.624290004647e-6, 1.30365583558e-6, 1.5626441722e-8, -8.5238095915e-8, 6.529054439e-9,
  5.059343495e-9, -9.91364156e-10, -2.27365122e-10, 9.6467911e-11, 2.394038e-12, -6.886027e-12, 8.94487e-13, 3.13092e-13,
  -1.12708e-13, 3.81e-16, 7.106e-15,
];

function erfcPositive(z: number): number {
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;
  let d = 0;
  let dd = 0;
  for (let j = ERFC_COF.length - 1; j > 0; j--) {
    const tmp = d;
    d = ty * d - dd + ERFC_COF[j]!;
    dd = tmp;
  }
  return t * Math.exp(-z * z + 0.5 * (ERFC_COF[0]! + ty * d) - dd);
}

// ---- the summary ----

export interface ForwardAnalysisPair {
  task: string;
  passOld: boolean;
  passNew: boolean;
  costOld: number | null;
  costNew: number | null;
  /** Reason the pair is invalid for both setups (DESIGN.md §"Forward run", invalidated tasks). */
  excluded?: string;
}

export interface ForwardSummary {
  /** Pairs counted: every pair that is not excluded. */
  n: number;
  excludedCount: number;
  /** Discordant counts: NEW passed and OLD failed, and the reverse. */
  newOnly: number;
  oldOnly: number;
  both: number;
  neither: number;
  /** McNemar exact two-sided p over newOnly vs oldOnly; 1 when there are no discordant pairs. */
  p: number;
  /** Whether a claim may be made at all: n >= 24, whatever p turns out to be. */
  claim: boolean;
  /** Wilcoxon signed-rank p on costNew - costOld, or null when no pair carries both costs. */
  costP: number | null;
  wording: string;
}

/** The forward result: the four counts, the McNemar p, the cost p and the sentence a report may print. */
export function forwardSummary(pairs: ForwardAnalysisPair[]): ForwardSummary {
  const counted = pairs.filter((p) => p.excluded === undefined);
  const newOnly = counted.filter((p) => p.passNew && !p.passOld).length;
  const oldOnly = counted.filter((p) => p.passOld && !p.passNew).length;
  const both = counted.filter((p) => p.passOld && p.passNew).length;
  const neither = counted.length - newOnly - oldOnly - both;
  const n = counted.length;
  const p = mcnemarExact(newOnly, oldOnly);

  const costed = counted.filter((p) => p.costOld !== null && p.costNew !== null);
  const costP = costed.length === 0 ? null : wilcoxonSignedRank(costed.map((p) => p.costNew! - p.costOld!)).p;

  const verdict = `${newOnly} vs ${oldOnly} passed, p = ${p.toFixed(3)}`;
  const wording = n < MIN_CLAIM_PAIRS ? `${verdict}; no claim: n = ${n} < ${MIN_CLAIM_PAIRS}` : p >= ALPHA ? `${verdict}; not significant at n = ${n}` : verdict;

  return { n, excludedCount: pairs.length - counted.length, newOnly, oldOnly, both, neither, p, claim: n >= MIN_CLAIM_PAIRS, costP, wording };
}
