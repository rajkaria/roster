// Mantel–Haenszel pooled odds ratio over 2x2 strata. See docs/DESIGN.md §"Difficulty and review".

/** One stratum: a/b = exposed bad/good, c/d = unexposed bad/good. */
export interface Stratum {
  a: number;
  b: number;
  c: number;
  d: number;
}

export interface MantelHaenszel {
  or: number;
  ci95: [number, number];
  /** Two-sided, from the continuity-corrected Mantel–Haenszel chi-square (1 df). */
  p: number;
}

const Z975 = 1.959963984540054;

/** Complementary error function, Numerical Recipes Chebyshev fit (relative error < 1.2e-7). */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const poly =
    -z * z -
    1.26551223 +
    t *
      (1.00002368 +
        t *
          (0.37409196 +
            t *
              (0.09678418 +
                t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))));
  const r = t * Math.exp(poly);
  return x >= 0 ? r : 2 - r;
}

function pooled(list: Stratum[]): { R: number; S: number } {
  let R = 0;
  let S = 0;
  for (const s of list) {
    const n = s.a + s.b + s.c + s.d;
    R += (s.a * s.d) / n;
    S += (s.b * s.c) / n;
  }
  return { R, S };
}

export function mantelHaenszel(strata: Stratum[]): MantelHaenszel {
  let used = strata.filter((s) => s.a + s.b + s.c + s.d > 0);
  let { R, S } = pooled(used);
  // Haldane–Anscombe: a zero pooled term makes the OR 0 or infinite, so add 0.5 to every cell.
  if (used.length > 0 && (R === 0 || S === 0)) {
    used = used.map((s) => ({ a: s.a + 0.5, b: s.b + 0.5, c: s.c + 0.5, d: s.d + 0.5 }));
    ({ R, S } = pooled(used));
  }
  if (used.length === 0 || R === 0 || S === 0) return { or: 1, ci95: [0, Infinity], p: 1 };

  // Robins–Breslow–Greenland variance of log(OR_MH).
  let sumPR = 0;
  let sumPSQR = 0;
  let sumQS = 0;
  for (const s of used) {
    const n = s.a + s.b + s.c + s.d;
    const P = (s.a + s.d) / n;
    const Q = (s.b + s.c) / n;
    const r = (s.a * s.d) / n;
    const q = (s.b * s.c) / n;
    sumPR += P * r;
    sumPSQR += P * q + Q * r;
    sumQS += Q * q;
  }
  const varLog = sumPR / (2 * R * R) + sumPSQR / (2 * R * S) + sumQS / (2 * S * S);
  const or = R / S;
  const se = Math.sqrt(varLog);
  const ci95: [number, number] = [Math.exp(Math.log(or) - Z975 * se), Math.exp(Math.log(or) + Z975 * se)];

  // Mantel–Haenszel chi-square with continuity correction, on the original tables.
  let sumA = 0;
  let sumE = 0;
  let sumV = 0;
  for (const s of strata) {
    const n = s.a + s.b + s.c + s.d;
    if (n < 2) continue;
    const r1 = s.a + s.b;
    const r2 = s.c + s.d;
    const c1 = s.a + s.c;
    const c2 = s.b + s.d;
    sumA += s.a;
    sumE += (r1 * c1) / n;
    sumV += (r1 * r2 * c1 * c2) / (n * n * (n - 1));
  }
  let p = 1;
  if (sumV > 0) {
    const dev = Math.max(0, Math.abs(sumA - sumE) - 0.5);
    p = erfc(Math.sqrt((dev * dev) / sumV / 2));
  }
  return { or, ci95, p };
}
