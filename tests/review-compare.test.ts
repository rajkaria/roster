import { expect, test } from "bun:test";
import { compareReviews } from "../src/review/compare";

test("rows, nulls, rounding, sorting, non-numeric ignored", () => {
  const before = { setups: [{ id: "b", score: 0.1, name: "x" }, { id: "a", score: 1, cost: 2 }] };
  const after = { setups: [{ id: "a", score: 1.2, name: "y" }, { id: "c", score: 3 }] };
  expect(compareReviews(before, after)).toEqual([
    { setup: "a", field: "cost", before: 2, after: null, delta: null },
    { setup: "a", field: "score", before: 1, after: 1.2, delta: 0.2 },
    { setup: "b", field: "score", before: 0.1, after: null, delta: null },
    { setup: "c", field: "score", before: null, after: 3, delta: null },
  ]);
});

test("identical reviews give zero deltas", () => {
  const r = { setups: [{ id: "a", x: 0.1 + 0.2, y: 5 }] };
  expect(compareReviews(r, r).every((row) => row.delta === 0)).toBe(true);
});

test("rounds to 4 decimals", () => {
  const rows = compareReviews({ setups: [{ id: "a", x: 0 }] }, { setups: [{ id: "a", x: 0.123456 }] });
  expect(rows[0]?.delta).toBe(0.1235);
});
