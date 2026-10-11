import { expect, test } from "bun:test";
import { costStats } from "../src/report/costs";

test("empty input", () => {
  expect(costStats([])).toEqual([]);
});

test("nulls excluded from stats, counted in nullCount; sorted by setup", () => {
  const rows = [
    { setup: "b", costUsd: 1 },
    { setup: "a", costUsd: 0.1 },
    { setup: "a", costUsd: null },
    { setup: "a", costUsd: 0.3 },
    { setup: "a", costUsd: 0.2 },
  ];
  expect(costStats(rows)).toEqual([
    { setup: "a", n: 3, nullCount: 1, totalUsd: 0.6, meanUsd: 0.2, p50Usd: 0.2, p90Usd: 0.3 },
    { setup: "b", n: 1, nullCount: 0, totalUsd: 1, meanUsd: 1, p50Usd: 1, p90Usd: 1 },
  ]);
});

test("nearest-rank percentiles on 10 values", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ setup: "s", costUsd: 10 - i }));
  const s = costStats(rows)[0]!;
  expect(s.p50Usd).toBe(5);
  expect(s.p90Usd).toBe(9);
  expect(s.meanUsd).toBe(5.5);
});

test("all-null setup", () => {
  expect(costStats([{ setup: "x", costUsd: null }])).toEqual([
    { setup: "x", n: 0, nullCount: 1, totalUsd: 0, meanUsd: null, p50Usd: null, p90Usd: null },
  ]);
});

test("rounds money to 4 decimals", () => {
  const s = costStats([
    { setup: "s", costUsd: 0.123456 },
    { setup: "s", costUsd: 0.000049 },
  ])[0]!;
  expect(s.totalUsd).toBe(0.1235);
  expect(s.meanUsd).toBe(0.0618);
  expect(s.p50Usd).toBe(0);
  expect(s.p90Usd).toBe(0.1235);
});
