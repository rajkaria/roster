import { describe, expect, test } from "bun:test";
import { costStats } from "../../../src/report/costs.ts";

describe("costStats", () => {
  test("returns an empty array for empty input", () => {
    expect(costStats([])).toEqual([]);
  });

  test("sorts output by setup", () => {
    const rows = [
      { setup: "z", costUsd: 1 },
      { setup: "a", costUsd: 2 },
      { setup: "m", costUsd: 3 },
    ];
    const result = costStats(rows);
    expect(result.map((row) => row.setup)).toEqual(["a", "m", "z"]);
  });

  test("counts nulls separately and excludes them from total, mean, and percentiles", () => {
    const rows = [
      { setup: "a", costUsd: 10 },
      { setup: "a", costUsd: null },
      { setup: "a", costUsd: 30 },
      { setup: "b", costUsd: null },
      { setup: "b", costUsd: null },
      { setup: "c", costUsd: 5 },
    ];
    const result = costStats(rows);
    const a = result.find((row) => row.setup === "a")!;
    const b = result.find((row) => row.setup === "b")!;
    const c = result.find((row) => row.setup === "c")!;

    expect(a.nullCount).toBe(1);
    expect(a.totalUsd).toBe(40);
    expect(a.meanUsd).toBe(20);
    expect(a.p50Usd).toBe(10);
    expect(a.p90Usd).toBe(30);

    expect(b.nullCount).toBe(2);
    expect(b.totalUsd).toBe(0);
    expect(b.meanUsd).toBeNull();
    expect(b.p50Usd).toBeNull();
    expect(b.p90Usd).toBeNull();

    expect(c.nullCount).toBe(0);
    expect(c.totalUsd).toBe(5);
    expect(c.meanUsd).toBe(5);
    expect(c.p50Usd).toBe(5);
    expect(c.p90Usd).toBe(5);
  });

  test("computes nearest-rank percentiles on sorted non-null values", () => {
    const rows = [
      { setup: "x", costUsd: 5 },
      { setup: "x", costUsd: 1 },
      { setup: "x", costUsd: 4 },
      { setup: "x", costUsd: 2 },
      { setup: "x", costUsd: 3 },
    ];
    const result = costStats(rows);
    expect(result).toHaveLength(1);
    expect(result[0].p50Usd).toBe(3); // rank = ceil(0.5 * 5) = 3
    expect(result[0].p90Usd).toBe(5); // rank = ceil(0.9 * 5) = 5
  });

  test("uses nearest-rank for an even number of values", () => {
    const rows = [
      { setup: "x", costUsd: 1 },
      { setup: "x", costUsd: 2 },
      { setup: "x", costUsd: 3 },
      { setup: "x", costUsd: 4 },
    ];
    const result = costStats(rows);
    expect(result[0].p50Usd).toBe(2); // rank = ceil(0.5 * 4) = 2
    expect(result[0].p90Usd).toBe(4); // rank = ceil(0.9 * 4) = 4
  });

  test("rounds total, mean, and percentiles to 4 decimals", () => {
    const rows = [
      { setup: "x", costUsd: 1.23456 },
      { setup: "x", costUsd: 2.34567 },
    ];
    const result = costStats(rows);
    const x = result[0];

    expect(x.totalUsd).toBe(3.5802);
    expect(x.meanUsd).toBe(1.7901);
    expect(x.p50Usd).toBe(1.2346);
    expect(x.p90Usd).toBe(2.3457);
  });
});
