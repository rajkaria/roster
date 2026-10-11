import { describe, expect, test } from "bun:test";
import { attributionAccuracy, tagAccuracy } from "../src/attribution/evaluate";

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

  test("matches by id, not by position", () => {
    const pred = [
      { id: "b", predicted: "y" },
      { id: "a", predicted: "x" },
    ];
    const key = [
      { id: "a", actual: "x" },
      { id: "b", actual: "y" },
    ];

    expect(attributionAccuracy(pred, key)).toEqual({
      correct: 2,
      total: 2,
      accuracy: 1,
      missing: [],
    });
  });

  test("ignores predictions with no key entry", () => {
    const pred = [
      { id: "a", predicted: "x" },
      { id: "ghost", predicted: "x" },
    ];
    const key = [{ id: "a", actual: "x" }];

    expect(attributionAccuracy(pred, key)).toEqual({
      correct: 1,
      total: 1,
      accuracy: 1,
      missing: [],
    });
  });

  test("keeps the last prediction for a repeated id", () => {
    const pred = [
      { id: "a", predicted: "wrong" },
      { id: "a", predicted: "x" },
    ];
    const key = [{ id: "a", actual: "x" }];

    expect(attributionAccuracy(pred, key)).toEqual({
      correct: 1,
      total: 1,
      accuracy: 1,
      missing: [],
    });
  });

  test("counts every key entry when a key id repeats", () => {
    const pred = [{ id: "a", predicted: "x" }];
    const key = [
      { id: "a", actual: "x" },
      { id: "a", actual: "y" },
    ];

    expect(attributionAccuracy(pred, key)).toEqual({
      correct: 1,
      total: 2,
      accuracy: 0.5,
      missing: [],
    });
  });

  test("lists missing ids in key order", () => {
    const key = [
      { id: "c", actual: "z" },
      { id: "a", actual: "x" },
      { id: "b", actual: "y" },
    ];

    expect(attributionAccuracy([], key).missing).toEqual(["c", "a", "b"]);
  });

  test("returns zero accuracy for an empty key and empty pred", () => {
    expect(attributionAccuracy([], [])).toEqual({
      correct: 0,
      total: 0,
      accuracy: 0,
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

  test("returns zero totals for an empty row list", () => {
    expect(tagAccuracy([])).toEqual({
      correct: 0,
      total: 0,
      accuracy: 0,
    });
  });

  test("scores a perfect 1:1 mapping as fully correct", () => {
    const rows = [
      { inferredSetup: "s1", tag: "A" },
      { inferredSetup: "s1", tag: "A" },
      { inferredSetup: "s2", tag: "B" },
      { inferredSetup: "s2", tag: "B" },
    ];

    expect(tagAccuracy(rows)).toEqual({
      correct: 4,
      total: 4,
      accuracy: 1,
    });
  });

  test("counts a tagged row with no inferred setup as wrong", () => {
    const rows = [
      { inferredSetup: "s1", tag: "A" },
      { inferredSetup: null, tag: "A" },
    ];

    expect(tagAccuracy(rows)).toEqual({
      correct: 1,
      total: 2,
      accuracy: 0.5,
    });
  });

  test("counts every row of a cluster whose top tag is tied as wrong", () => {
    const rows = [
      { inferredSetup: "s1", tag: "A" },
      { inferredSetup: "s1", tag: "B" },
      { inferredSetup: "s2", tag: "A" },
    ];

    expect(tagAccuracy(rows)).toEqual({
      correct: 1,
      total: 3,
      accuracy: 0.3333,
    });
  });

  test("ignores untagged rows when deciding a cluster's tag", () => {
    const rows = [
      { inferredSetup: "s1", tag: "A" },
      { inferredSetup: "s1", tag: null },
      { inferredSetup: "s1", tag: null },
      { inferredSetup: "s1", tag: "B" },
    ];

    // Two untagged rows do not break the A/B tie: the vote is A 1, B 1, so no tag is named.
    expect(tagAccuracy(rows)).toEqual({
      correct: 0,
      total: 2,
      accuracy: 0,
    });
  });

  test("maps separate clusters independently", () => {
    const rows = [
      { inferredSetup: "s1", tag: "A" },
      { inferredSetup: "s2", tag: "A" },
      { inferredSetup: "s3", tag: "B" },
      { inferredSetup: "s3", tag: "B" },
      { inferredSetup: "s3", tag: "A" },
    ];

    // Two clusters naming the same tag is fine, and s3's B/B/A names B, so its A row is wrong.
    expect(tagAccuracy(rows)).toEqual({
      correct: 4,
      total: 5,
      accuracy: 0.8,
    });
  });
});
