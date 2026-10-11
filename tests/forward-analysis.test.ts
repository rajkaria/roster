import { describe, expect, test } from "bun:test";
import { forwardSummary, mcnemarExact, normalCdf, wilcoxonSignedRank } from "../src/forward/analysis.ts";

describe("mcnemarExact", () => {
  test("no discordant pairs is no evidence", () => {
    expect(mcnemarExact(0, 0)).toBe(1);
  });

  test("one discordant pair cannot reach significance", () => {
    // 2 * (C(1,0) + C(1,1)) / 2 = 1: a coin that landed once says nothing.
    expect(mcnemarExact(0, 1)).toBeCloseTo(1, 12);
    expect(mcnemarExact(1, 0)).toBeCloseTo(1, 12);
  });

  test("matches the exact binomial for a small tail", () => {
    expect(mcnemarExact(0, 6)).toBeCloseTo(0.03125, 12); // 2 * 2^-6
    expect(mcnemarExact(1, 12)).toBeCloseTo((2 * 14) / 8192, 12); // 2 * (C(13,0) + C(13,1)) * 2^-13
    expect(mcnemarExact(2, 10)).toBeCloseTo(158 / 4096, 12); // 2 * (1 + 12 + 66) * 2^-12
  });

  test("is symmetric in b and c", () => {
    for (const [b, c] of [[0, 3], [1, 4], [3, 3], [7, 2], [11, 5]] as const) {
      expect(mcnemarExact(b, c)).toBe(mcnemarExact(c, b));
    }
  });

  test("caps at 1 when the two discordant counts agree", () => {
    expect(mcnemarExact(3, 3)).toBe(1); // raw 2 * 42 / 64
    expect(mcnemarExact(10, 10)).toBe(1);
  });

  test("stays finite for counts large enough to overflow a naive binomial", () => {
    const p = mcnemarExact(200, 220);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
    expect(mcnemarExact(0, 2000)).toBeGreaterThanOrEqual(0);
    expect(mcnemarExact(0, 2000)).toBeLessThan(1e-100);
  });
});

describe("wilcoxonSignedRank", () => {
  test("all zeros: no non-zero difference, p = 1", () => {
    expect(wilcoxonSignedRank([0, 0, 0])).toEqual({ w: 0, p: 1, n: 0 });
  });

  test("empty input is the same as all zeros", () => {
    expect(wilcoxonSignedRank([])).toEqual({ w: 0, p: 1, n: 0 });
  });

  test("zeros are dropped from n", () => {
    const r = wilcoxonSignedRank([0, 1, -2]);
    expect(r.n).toBe(2);
    expect(r.w).toBe(1); // the +1 outranks nothing: |1| < |2|
  });

  test("tied absolute differences share their average rank", () => {
    const r = wilcoxonSignedRank([1, -1]);
    expect(r.n).toBe(2);
    expect(r.w).toBe(1.5);
  });

  test("exact distribution for n = 20: all positive", () => {
    const r = wilcoxonSignedRank(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(r.n).toBe(20);
    expect(r.w).toBe(210);
    expect(r.p).toBeCloseTo(1 / 524288, 12); // 2 * 2^-20
  });

  test("exact distribution: the two tails are symmetric", () => {
    const allPositive = wilcoxonSignedRank(Array.from({ length: 10 }, (_, i) => i + 1));
    const allNegative = wilcoxonSignedRank(Array.from({ length: 10 }, (_, i) => -(i + 1)));
    expect(allPositive.w).toBe(55);
    expect(allNegative.w).toBe(0);
    expect(allPositive.p).toBeCloseTo(allNegative.p, 12);
    expect(allPositive.p).toBeCloseTo(2 / 1024, 12);
  });

  test("exact distribution: a middling split is not significant", () => {
    const r = wilcoxonSignedRank([1, 2, 3, -4, -5, -6, -7, -8]);
    expect(r.n).toBe(8);
    expect(r.p).toBeGreaterThan(0.05);
  });

  test("normal approximation for n = 21", () => {
    const r = wilcoxonSignedRank(Array.from({ length: 21 }, (_, i) => i + 1));
    expect(r.n).toBe(21);
    expect(r.w).toBe(231);
    // mean 115.5, sd ~= sqrt((21 * 22 * 43) / 24) = 28.7695; z = (231 - 115.5 - 0.5) / sd = 3.9973
    expect(r.p).toBeGreaterThan(0);
    expect(r.p).toBeLessThan(1);
    expect(r.p).toBeCloseTo(2 * (1 - normalCdf(115 / Math.sqrt((21 * 22 * 43) / 24))), 12);
  });

  test("n = 21 with ties still lands in [0, 1]", () => {
    const diffs = [...Array.from({ length: 22 }, () => 2), ...Array.from({ length: 3 }, () => -2)];
    const r = wilcoxonSignedRank(diffs);
    expect(r.n).toBe(25);
    expect(r.p).toBeGreaterThanOrEqual(0);
    expect(r.p).toBeLessThanOrEqual(1);
  });

  test("exact and normal branches agree at the boundary", () => {
    const diffs = Array.from({ length: 20 }, (_, i) => i + 1);
    const exact = wilcoxonSignedRank(diffs).p;
    const normal = 2 * (1 - normalCdf((210 - 105 - 0.5) / Math.sqrt((20 * 21 * 41) / 24)));
    // Both are tiny; the normal tail is the looser one, so they only agree to a few times its own size.
    expect(Math.abs(exact - normal)).toBeLessThan(2e-4);
  });
});

describe("normalCdf", () => {
  test("matches published standard normal values", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 10);
    expect(normalCdf(1)).toBeCloseTo(0.8413447461, 8);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021049, 8);
    expect(normalCdf(2.5758293035)).toBeCloseTo(0.995, 8);
    expect(normalCdf(-1.96)).toBeCloseTo(0.0249978951, 8);
  });
});

describe("forwardSummary", () => {
  const pair = (task: string, passOld: boolean, passNew: boolean) => ({ task, passOld, passNew, costOld: null, costNew: null });

  test("counts the four outcome cells", () => {
    const s = forwardSummary([
      pair("a", false, true),
      pair("b", true, false),
      pair("c", true, true),
      pair("d", false, false),
    ]);
    expect(s).toMatchObject({ n: 4, excludedCount: 0, newOnly: 1, oldOnly: 1, both: 1, neither: 1, p: 1, claim: false });
    expect(s.wording).toContain("no claim: n = 4 < 24");
  });

  test("excluded pairs leave n alone and are counted separately", () => {
    const pairs = [pair("a", false, true), { ...pair("gone", false, true), excluded: "F6: setup error" }];
    const s = forwardSummary(pairs);
    expect(s.n).toBe(1);
    expect(s.excludedCount).toBe(1);
    expect(s.newOnly).toBe(1);
    expect(s.p).toBe(1); // the excluded win does not count as discordance
  });

  test("a discordant win is significant once n reaches 24", () => {
    const pairs = [
      ...Array.from({ length: 6 }, (_, i) => pair(`new-${i}`, false, true)),
      ...Array.from({ length: 18 }, (_, i) => pair(`both-${i}`, true, true)),
    ];
    const s = forwardSummary(pairs);
    expect(s.n).toBe(24);
    expect(s.p).toBeCloseTo(0.03125, 12);
    expect(s.claim).toBe(true);
    expect(s.wording).toBe("6 vs 0 passed, p = 0.031");
  });

  test("claim means the sample is big enough, not that the result is significant", () => {
    const s = forwardSummary(Array.from({ length: 24 }, (_, i) => pair(`both-${i}`, true, true)));
    expect(s.claim).toBe(true);
    expect(s.p).toBe(1);
    expect(s.wording).toBe("0 vs 0 passed, p = 1.000; not significant at n = 24");
  });

  test("a regression reads as old-side wins", () => {
    const pairs = [
      ...Array.from({ length: 18 }, (_, i) => pair(`both-${i}`, true, true)),
      ...Array.from({ length: 6 }, (_, i) => pair(`old-${i}`, true, false)),
    ];
    const s = forwardSummary(pairs);
    expect(s).toMatchObject({ newOnly: 0, oldOnly: 6, claim: true });
    expect(s.p).toBeCloseTo(0.03125, 12);
    expect(s.wording).toContain("0 vs 6 passed, p = 0.031");
  });

  test("costP needs a pair with both costs, and uses new minus old", () => {
    expect(forwardSummary([pair("a", true, true)]).costP).toBeNull();
    expect(forwardSummary([{ ...pair("a", true, true), costOld: 1, costNew: 1 }]).costP).toBe(1); // zero difference
    const cheaper = Array.from({ length: 12 }, (_, i) => ({ ...pair(`c-${i}`, true, true), costOld: 1, costNew: 0.5 }));
    const pricier = Array.from({ length: 2 }, (_, i) => ({ ...pair(`p-${i}`, true, true), costOld: 0.5, costNew: 1 }));
    const p = forwardSummary([...cheaper, ...pricier]).costP;
    expect(p).not.toBeNull();
    expect(p!).toBeLessThan(0.05);
  });

  test("an empty run cannot claim", () => {
    const s = forwardSummary([]);
    expect(s).toMatchObject({ n: 0, excludedCount: 0, neither: 0, p: 1, claim: false, costP: null });
    expect(s.wording).toContain("no claim: n = 0 < 24");
  });
});
