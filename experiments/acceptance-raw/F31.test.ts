import { test, expect } from "bun:test";
import { nightlyComment } from "../../../src/cli/nightly.ts";

type NightlyRow = Parameters<typeof nightlyComment>[0][number];

function makeRow(overrides: Partial<NightlyRow> = {}): NightlyRow {
  return {
    setup: "alpha",
    field: "field",
    before: 1,
    after: 2,
    delta: 1,
    ...overrides,
  };
}

const baseOpts = { repo: "owner/repo", date: "2025-01-01", threshold: 5 };

test("uses a Markdown heading with repo and date", () => {
  const result = nightlyComment([], {
    repo: "owner/repo",
    date: "2025-01-02",
    threshold: 5,
  });

  expect(result.trimStart()).toMatch(
    /^#{1,6}\s+Roster nightly review: owner\/repo, 2025-01-02/,
  );
});

test("prints the nothing-above-threshold message when no row qualifies", () => {
  const result = nightlyComment(
    [
      makeRow({ field: "small-up", before: 0, after: 3, delta: 3 }),
      makeRow({ field: "small-down", before: 10, after: 7, delta: -3 }),
      makeRow({ field: "null-delta", before: null, after: null, delta: null }),
    ],
    { repo: "owner/repo", date: "2025-01-02", threshold: 5 },
  );

  expect(result).toContain("No changes above 5.");
  expect(result).not.toContain("small-up");
  expect(result).not.toContain("small-down");
  expect(result).not.toContain("null-delta");
});

test("lists only rows with absolute delta at or above threshold", () => {
  const result = nightlyComment(
    [
      makeRow({ field: "kept-positive", delta: 5 }),
      makeRow({ field: "kept-negative", delta: -6 }),
      makeRow({ field: "dropped-low", delta: 4 }),
      makeRow({ field: "dropped-null", delta: null }),
    ],
    baseOpts,
  );

  expect(result).toContain("kept-positive");
  expect(result).toContain("kept-negative");
  expect(result).not.toContain("dropped-low");
  expect(result).not.toContain("dropped-null");
});

test("marks positive and negative changes with up and down arrows", () => {
  const result = nightlyComment(
    [
      makeRow({ field: "up-field", delta: 5 }),
      makeRow({ field: "down-field", delta: -7 }),
    ],
    baseOpts,
  );

  const upLine = result
    .split("\n")
    .find((line) => line.includes("up-field"))!;
  const downLine = result
    .split("\n")
    .find((line) => line.includes("down-field"))!;

  expect(upLine).toContain("▲");
  expect(downLine).toContain("▼");
});

test("groups rows by setup without interleaving setup groups", () => {
  const result = nightlyComment(
    [
      makeRow({ setup: "alpha", field: "alpha-one", delta: 5 }),
      makeRow({ setup: "beta", field: "beta-one", delta: 6 }),
      makeRow({ setup: "alpha", field: "alpha-two", delta: 7 }),
    ],
    baseOpts,
  );

  const alphaOne = result.indexOf("alpha-one");
  const alphaTwo = result.indexOf("alpha-two");
  const betaOne = result.indexOf("beta-one");

  expect(alphaOne).toBeGreaterThan(-1);
  expect(alphaTwo).toBeGreaterThan(-1);
  expect(betaOne).toBeGreaterThan(-1);

  // The beta row must not split the alpha rows.
  expect(betaOne < alphaOne || betaOne > alphaTwo).toBe(true);
});

test("caps listed rows at 20 and adds +N more", () => {
  const rows = Array.from({ length: 25 }, (_, i) =>
    makeRow({
      setup: "alpha",
      field: `row-${String(i + 1).padStart(2, "0")}`,
      delta: 5 + i,
    }),
  );

  const result = nightlyComment(rows, baseOpts);

  expect(result).toContain("+5 more");
  expect(result).not.toContain("row-21");

  for (let i = 1; i <= 20; i += 1) {
    expect(result).toContain(`row-${String(i).padStart(2, "0")}`);
  }
});

test("includes zero delta when threshold is zero", () => {
  const result = nightlyComment(
    [makeRow({ field: "zero", before: 5, after: 5, delta: 0 })],
    { ...baseOpts, threshold: 0 },
  );

  expect(result).toContain("zero");
});
