import { describe, expect, test } from "bun:test";
import { attributionAccuracy, tagAccuracy } from "../../src/attribution/evaluate";

describe("attributionAccuracy", () => {
  test("counts key entries and matches predicted to actual by id", () => {
    const pred = [
      { id: "a", predicted: "x" },
      { id: "b", predicted: "y" },
    ];
    const key = [
      { id: "a", actual: "x" },
      { id: "b", actual: "z" },
    ];

    expect(attributionAccuracy(pred, key)).toEqual({
      correct: 1,
      total: 2,
      accuracy: 0.5,
      missing: [],
    });
  });

  test("lists key ids missing from pred as wrong", () => {
    const pred = [{ id: "a", predicted: "x" }];
    const key = [
      { id: "a", actual: "x" },
      { id: "b", actual: "y" },
      { id: "c", actual: "z" },
    ];

    expect(attributionAccuracy(pred, key)).toEqual({
      correct: 1,
      total: 3,
      accuracy: 0.3333,
      missing: ["b", "c"],
    });
  });

  test("counts a mismatching predicted value as wrong", () => {
    const pred = [{ id: "a", predicted: "x" }];
    const key = [{ id: "a", actual: "y" }];

    expect(attributionAccuracy(pred, key)).toEqual({
      correct: 0,
      total: 1,
      accuracy: 0,
      missing: [],
    });
  });

  test("returns zero accuracy and empty missing for an empty key", () => {
    expect(attributionAccuracy([{ id: "a", predicted: "x" }], [])).toEqual({
      correct: 0,
      total: 0,
      accuracy: 0,
      missing: [],
    });
  });

  test("rounds accuracy to four decimals", () => {
    const pred = [
      { id: "a", predicted: "x" },
      { id: "b", predicted: "y" },
      { id: "c", predicted: "wrong" },
    ];
    const key = [
      { id: "a", actual: "x" },
      { id: "b", actual: "y" },
      { id: "c", actual: "z" },
    ];

    expect(attributionAccuracy(pred, key)).toEqual({
      correct: 2,
      total: 3,
      accuracy: 0.6667,
      missing: [],
    });
  });
});

describe("tagAccuracy", () => {
  test("counts only rows with a tag and maps clusters to tags by majority vote", () => {
    const rows = [
      { inferredSetup: "s1", tag: "A" },
      { inferredSetup: "s1", tag: "A" },
      { inferredSetup: "s1", tag: "B" },
      { inferredSetup: "s1", tag: null },
      { inferredSetup: "s2", tag: "A" },
      { inferredSetup: "s2", tag: null },
    ];

    expect(tagAccuracy(rows)).toEqual({
      correct: 3,
      total: 4,
      accuracy: 0.75,
    });
  });

  test("returns zero totals and accuracy when no rows have a tag", () => {
    const rows = [
      { inferredSetup: "s1", tag: null },
      { inferredSetup: null, tag: null },
    ];

    expect(tagAccuracy(rows)).toEqual({
      correct: 0,
      total: 0,
      accuracy: 0,
    });
  });

  test("rounds tag accuracy to four decimals", () => {
    const rows = [
      { inferredSetup: "s1", tag: "A" },
      { inferredSetup: "s1", tag: "A" },
      { inferredSetup: "s1", tag: "B" },
    ];

    expect(tagAccuracy(rows)).toEqual({
      correct: 2,
      total: 3,
      accuracy: 0.6667,
    });
  });
});
