import { describe, expect, test } from "bun:test";
import {
  mcnemarExact,
  wilcoxonSignedRank,
  forwardSummary,
} from "../../../src/forward/analysis.ts";

describe("mcnemarExact", () => {
  test("returns 1 when there are no discordant pairs", () => {
    expect(mcnemarExact(0, 0)).toBe(1);
  });

  test("is symmetric in b and c", () => {
    const cases: Array<[number, number]> = [
      [0, 3],
      [1, 4],
      [3, 3],
      [7, 2],
    ];
    for (const [b, c] of cases) {
      expect(mcnemarExact(b, c)).toBe(mcnemarExact(c, b));
    }
  });

  test("computes the two-sided exact binomial for extreme discordance", () => {
    expect(mcnemarExact(0, 6)).toBeCloseTo(0.03125, 10);
    expect(mcnemarExact(6, 0)).toBeCloseTo(0.03125, 10);
  });
});

describe("wilcoxonSignedRank", () => {
  test("returns p = 1 and n = 0 when all differences are zero", () => {
    const result = wilcoxonSignedRank([0, 0, 0]);
    expect(result.p).toBe(1);
    expect(result.n).toBe(0);
    expect(result.w).toBe(0);
  });

  test("drops zeros from the non-zero count", () => {
    const result = wilcoxonSignedRank([0, 1, -2]);
    expect(result.n).toBe(2);
  });

  test("uses average ranks for tied absolute differences", () => {
    const result = wilcoxonSignedRank([1, -1]);
    expect(result.n).toBe(2);
    expect(result.w).toBe(1.5);
  });

  test("uses exact distribution for n <= 20", () => {
    const diffs = Array.from({ length: 20 }, (_, i) => i + 1);
    const result = wilcoxonSignedRank(diffs);
    expect(result.n).toBe(20);
    expect(result.w).toBe(210);
    expect(result.p).toBeCloseTo(1 / 524288, 10);
  });

  test("uses normal approximation for n > 20", () => {
    const diffs = Array.from({ length: 21 }, (_, i) => i + 1);
    const result = wilcoxonSignedRank(diffs);
    expect(result.n).toBe(21);
    expect(result.p).toBeGreaterThanOrEqual(0);
    expect(result.p).toBeLessThanOrEqual(1);
  });
});

describe("forwardSummary", () => {
  test("cannot claim when n is below 24", () => {
    const pairs = Array.from({ length: 23 }, (_, i) => ({
      task: `task-${i}`,
      passOld: false,
      passNew: false,
      costOld: null,
      costNew: null,
    }));

    const result = forwardSummary(pairs);

    expect(result.n).toBe(23);
    expect(result.excludedCount).toBe(0);
    expect(result.neither).toBe(23);
    expect(result.p).toBe(1);
    expect(result.claim).toBe(false);
    expect(result.wording).toContain("no claim: n = 23 < 24");
  });

  test("excluded pairs are counted separately and do not increase n", () => {
    const pairs = Array.from({ length: 23 }, (_, i) => ({
      task: `task-${i}`,
      passOld: false,
      passNew: false,
      costOld: null,
      costNew: null,
    }));
    pairs.push({
      task: "excluded-task",
      passOld: true,
      passNew: false,
      costOld: null,
      costNew: null,
      excluded: "F6",
    });

    const result = forwardSummary(pairs);

    expect(result.n).toBe(23);
    expect(result.excludedCount).toBe(1);
    expect(result.claim).toBe(false);
  });

  test("significant improvement with n = 24 formats the wording", () => {
    const pairs = [
      ...Array.from({ length: 6 }, (_, i) => ({
        task: `new-only-${i}`,
        passOld: false,
        passNew: true,
        costOld: null,
        costNew: null,
      })),
      ...Array.from({ length: 18 }, (_, i) => ({
        task: `both-${i}`,
        passOld: true,
        passNew: true,
        costOld: null,
        costNew: null,
      })),
    ];

    const result = forwardSummary(pairs);

    expect(result.n).toBe(24);
    expect(result.newOnly).toBe(6);
    expect(result.oldOnly).toBe(0);
    expect(result.both).toBe(18);
    expect(result.neither).toBe(0);
    expect(result.p).toBeCloseTo(0.03125, 10);
    expect(result.claim).toBe(true);
    expect(result.wording).toContain("passed, p = 0.031");
  });

  test("not significant when p >= 0.05 even when n is at least 24", () => {
    const pairs = Array.from({ length: 24 }, (_, i) => ({
      task: `both-${i}`,
      passOld: true,
      passNew: true,
      costOld: null,
      costNew: null,
    }));

    const result = forwardSummary(pairs);

    expect(result.n).toBe(24);
    expect(result.p).toBe(1);
    expect(result.claim).toBe(true);
    expect(result.wording).toContain("not significant at n = 24");
  });
});
