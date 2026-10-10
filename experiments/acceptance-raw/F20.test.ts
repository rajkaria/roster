import { describe, expect, test } from "bun:test";
import { buildCorpusTable } from "../../../src/review/corpus-table.ts";

type ReviewRow = Parameters<typeof buildCorpusTable>[0][number];

const row = (overrides: Partial<ReviewRow> = {}): ReviewRow => ({
  repo: "repo",
  sessions: 1,
  setups: 1,
  costUsd: null,
  suspect: null,
  replayed: 0,
  promoted: null,
  ...overrides,
});

describe("buildCorpusTable", () => {
  test("sorts rows by sessions descending, then repo ascending", () => {
    const reviews: ReviewRow[] = [
      row({ repo: "beta", sessions: 2 }),
      row({ repo: "alpha", sessions: 3 }),
      row({ repo: "gamma", sessions: 2 }),
      row({ repo: "delta", sessions: 1 }),
    ];

    const { rows } = buildCorpusTable(reviews);

    expect(rows.map((r) => r.repo)).toEqual(["alpha", "beta", "gamma", "delta"]);
    expect(rows.map((r) => r.sessions)).toEqual([3, 2, 2, 1]);
  });

  test("totals are re-added from the sorted rows", () => {
    const reviews: ReviewRow[] = [
      row({ repo: "a", sessions: 3, setups: 2, costUsd: 10, suspect: "x", replayed: 4, promoted: "p" }),
      row({ repo: "b", sessions: 1, setups: 1, costUsd: 5, suspect: null, replayed: 2, promoted: null }),
      row({ repo: "c", sessions: 2, setups: 3, costUsd: null, suspect: null, replayed: 0, promoted: "q" }),
    ];

    const { rows, totals } = buildCorpusTable(reviews);
    const sum = (values: number[]) => values.reduce((acc, n) => acc + n, 0);
    const costs = rows.map((r) => r.costUsd).filter((v): v is number => v !== null);

    expect(totals.repos).toBe(rows.length);
    expect(totals.sessions).toBe(sum(rows.map((r) => r.sessions)));
    expect(totals.replayed).toBe(sum(rows.map((r) => r.replayed)));
    expect(totals.promotions).toBe(rows.filter((r) => r.promoted !== null).length);
    expect(totals.costUsd).toBe(costs.length === 0 ? null : sum(costs));
  });

  test("costUsd total is null when every row has null costUsd", () => {
    const reviews: ReviewRow[] = [
      row({ repo: "a", sessions: 1, costUsd: null }),
      row({ repo: "b", sessions: 2, costUsd: null }),
    ];

    const { totals } = buildCorpusTable(reviews);

    expect(totals.costUsd).toBeNull();
  });

  test("costUsd total sums only non-null rows", () => {
    const reviews: ReviewRow[] = [
      row({ repo: "a", sessions: 1, costUsd: 12.5 }),
      row({ repo: "b", sessions: 2, costUsd: null }),
      row({ repo: "c", sessions: 3, costUsd: 7.25 }),
    ];

    const { totals } = buildCorpusTable(reviews);

    expect(totals.costUsd).toBe(19.75);
  });

  test("promotions counts rows where promoted is non-null", () => {
    const reviews: ReviewRow[] = [
      row({ repo: "a", sessions: 3, promoted: "yes" }),
      row({ repo: "b", sessions: 2, promoted: "" }),
      row({ repo: "c", sessions: 1, promoted: null }),
    ];

    const { totals } = buildCorpusTable(reviews);

    expect(totals.promotions).toBe(2);
  });
});
