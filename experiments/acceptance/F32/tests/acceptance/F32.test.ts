import { describe, expect, test } from "bun:test";
import { rankExisting } from "../../src/candidates/existing.ts";

type Candidate = {
  id: string;
  badRate: number | null;
  sessions: number;
  costPerSession: number | null;
};

const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  id: "a",
  badRate: 0,
  sessions: 5,
  costPerSession: 0,
  ...overrides,
});

describe("rankExisting", () => {
  test("excludes the suspect setup", () => {
    const setups = [
      candidate({ id: "suspect", badRate: 0, sessions: 5, costPerSession: 0 }),
      candidate({ id: "other", badRate: 0.8, sessions: 5, costPerSession: 10 }),
    ];

    expect(rankExisting(setups, "suspect", 10)).toEqual(["other"]);
  });

  test("excludes setups with fewer than three sessions", () => {
    const setups = [
      candidate({ id: "two", badRate: 0, sessions: 2, costPerSession: 0 }),
      candidate({ id: "zero", badRate: 0, sessions: 0, costPerSession: 0 }),
      candidate({ id: "three", badRate: 0.5, sessions: 3, costPerSession: 0 }),
      candidate({ id: "many", badRate: 0.1, sessions: 7, costPerSession: 0 }),
    ];

    expect(rankExisting(setups, "suspect", 10)).toEqual(["many", "three"]);
  });

  test("sorts by badRate ascending with null badRate last", () => {
    const setups = [
      candidate({ id: "high", badRate: 0.9, sessions: 5, costPerSession: 0 }),
      candidate({ id: "null-b", badRate: null, sessions: 5, costPerSession: 0 }),
      candidate({ id: "null-a", badRate: null, sessions: 5, costPerSession: 0 }),
      candidate({ id: "low", badRate: 0.2, sessions: 5, costPerSession: 0 }),
    ];

    expect(rankExisting(setups, "suspect", 10)).toEqual([
      "low",
      "high",
      "null-a",
      "null-b",
    ]);
  });

  test("sorts by costPerSession ascending with null cost last within equal badRate", () => {
    const setups = [
      candidate({ id: "expensive", badRate: 0.3, sessions: 5, costPerSession: 10 }),
      candidate({ id: "unknown", badRate: 0.3, sessions: 5, costPerSession: null }),
      candidate({ id: "cheap", badRate: 0.3, sessions: 5, costPerSession: 1 }),
      candidate({ id: "mid", badRate: 0.3, sessions: 5, costPerSession: 2 }),
    ];

    expect(rankExisting(setups, "suspect", 10)).toEqual([
      "cheap",
      "mid",
      "expensive",
      "unknown",
    ]);
  });

  test("sorts by id ascending when badRate and costPerSession tie", () => {
    const setups = [
      candidate({ id: "c", badRate: 0.3, sessions: 5, costPerSession: 1 }),
      candidate({ id: "a", badRate: 0.3, sessions: 5, costPerSession: 1 }),
      candidate({ id: "b", badRate: 0.3, sessions: 5, costPerSession: 1 }),
    ];

    expect(rankExisting(setups, "suspect", 10)).toEqual(["a", "b", "c"]);
  });

  test("returns at most max ids", () => {
    const setups = [
      candidate({ id: "d", badRate: 0.3, sessions: 5, costPerSession: 1 }),
      candidate({ id: "b", badRate: 0.3, sessions: 5, costPerSession: 1 }),
      candidate({ id: "a", badRate: 0.3, sessions: 5, costPerSession: 1 }),
      candidate({ id: "c", badRate: 0.3, sessions: 5, costPerSession: 1 }),
    ];

    expect(rankExisting(setups, "suspect", 2)).toEqual(["a", "b"]);
  });

  test("returns empty when max is zero", () => {
    const setups = [
      candidate({ id: "a", badRate: 0.3, sessions: 5, costPerSession: 1 }),
    ];

    expect(rankExisting(setups, "suspect", 0)).toEqual([]);
  });

  test("returns empty when there are no eligible setups", () => {
    const setups = [
      candidate({ id: "suspect", badRate: 0, sessions: 5, costPerSession: 0 }),
      candidate({ id: "too-few", badRate: 0, sessions: 2, costPerSession: 0 }),
    ];

    expect(rankExisting(setups, "suspect", 10)).toEqual([]);
  });
});
