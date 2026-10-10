import { test, expect } from "bun:test";
import { compareReviews } from "../../src/review/compare.ts";

test("returns one row per setup and numeric field, sorted by setup then field, with null for missing sides", () => {
  const before = {
    setups: [
      { id: "z-last", sessions: 1, survival: 0.1 },
      { id: "a-first", sessions: 2, cost_usd: 5.55555, label: "ignore-me", survival: 0.5 },
    ],
  };

  const after = {
    setups: [
      { id: "z-last", sessions: 3, cost_usd: 10, reverted: 0.25 },
      { id: "a-first", sessions: 4, survival: 0.75, label: "ignore-me-too" },
    ],
  };

  expect(compareReviews(before, after)).toEqual([
    { setup: "a-first", field: "cost_usd", before: 5.55555, after: null, delta: null },
    { setup: "a-first", field: "sessions", before: 2, after: 4, delta: 2 },
    { setup: "a-first", field: "survival", before: 0.5, after: 0.75, delta: 0.25 },
    { setup: "z-last", field: "cost_usd", before: null, after: 10, delta: null },
    { setup: "z-last", field: "reverted", before: null, after: 0.25, delta: null },
    { setup: "z-last", field: "sessions", before: 1, after: 3, delta: 2 },
    { setup: "z-last", field: "survival", before: 0.1, after: null, delta: null },
  ]);
});

test("treats a setup present on only one side as missing on the other", () => {
  const before = {
    setups: [{ id: "old-setup", sessions: 5 }],
  };

  const after = {
    setups: [{ id: "new-setup", sessions: 15 }],
  };

  expect(compareReviews(before, after)).toEqual([
    { setup: "new-setup", field: "sessions", before: null, after: 15, delta: null },
    { setup: "old-setup", field: "sessions", before: 5, after: null, delta: null },
  ]);
});

test("ignores non-numeric fields", () => {
  const before = {
    setups: [{ id: "s", count: 1, enabled: true, note: "old" }],
  };

  const after = {
    setups: [{ id: "s", count: 2, enabled: false, note: "new" }],
  };

  expect(compareReviews(before, after)).toEqual([
    { setup: "s", field: "count", before: 1, after: 2, delta: 1 },
  ]);
});

test("returns all deltas as 0 for identical reviews", () => {
  const before = {
    setups: [{ id: "s", sessions: 7, survival: 0.5, cost_usd: 1.25, label: "same" }],
  };

  const after = {
    setups: [{ id: "s", sessions: 7, survival: 0.5, cost_usd: 1.25, label: "same" }],
  };

  expect(compareReviews(before, after)).toEqual([
    { setup: "s", field: "cost_usd", before: 1.25, after: 1.25, delta: 0 },
    { setup: "s", field: "sessions", before: 7, after: 7, delta: 0 },
    { setup: "s", field: "survival", before: 0.5, after: 0.5, delta: 0 },
  ]);
});

test("rounds delta = after - before to four decimals", () => {
  const before = {
    setups: [{ id: "s", value: 0 }],
  };

  const after = {
    setups: [{ id: "s", value: 0.00006 }],
  };

  expect(compareReviews(before, after)).toEqual([
    { setup: "s", field: "value", before: 0, after: 0.00006, delta: 0.0001 },
  ]);
});
