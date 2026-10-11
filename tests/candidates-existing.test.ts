import { describe, expect, test } from "bun:test";
import { rankExisting } from "../src/candidates/existing.ts";

type Setup = {
  id: string;
  badRate: number | null;
  sessions: number;
  costPerSession: number | null;
};

const setup = (overrides: Partial<Setup> = {}): Setup => ({
  id: "a",
  badRate: 0,
  sessions: 5,
  costPerSession: 0,
  ...overrides,
});

describe("rankExisting", () => {
  test("drops the suspect and the under-observed, keeping the rest in rank order", () => {
    const setups = [
      setup({ id: "x", badRate: 0.6, sessions: 20, costPerSession: 3 }),
      setup({ id: "y", badRate: 0.1, sessions: 4, costPerSession: 5 }),
      setup({ id: "z", badRate: 0.2, sessions: 9, costPerSession: 1 }),
      setup({ id: "thin", badRate: 0.0, sessions: 2, costPerSession: 1 }),
      setup({ id: "w", badRate: null, sessions: 6, costPerSession: 2 }),
    ];

    // y (0.1) < z (0.2) < x (0.6) < w (null bad rate); "thin" is under MIN_SESSIONS.
    expect(rankExisting(setups, "suspect", 10)).toEqual(["y", "z", "x", "w"]);
    // Naming x as the suspect removes it from its own replacement list.
    expect(rankExisting(setups, "x", 10)).toEqual(["y", "z", "w"]);
  });

  test("keeps a setup with exactly three sessions", () => {
    const setups = [setup({ id: "edge", sessions: 3 }), setup({ id: "under", sessions: 2 })];
    expect(rankExisting(setups, "suspect", 10)).toEqual(["edge"]);
  });

  test("ranks a priced setup above an unpriced one when bad rates tie", () => {
    const setups = [
      setup({ id: "unpriced", badRate: 0.4, costPerSession: null }),
      setup({ id: "priced", badRate: 0.4, costPerSession: 99 }),
    ];
    expect(rankExisting(setups, "suspect", 10)).toEqual(["priced", "unpriced"]);
  });

  test("breaks a full tie on id, so the order is stable across input order", () => {
    const forward = [
      setup({ id: "b", badRate: 0.2, costPerSession: 1 }),
      setup({ id: "a", badRate: 0.2, costPerSession: 1 }),
      setup({ id: "c", badRate: 0.2, costPerSession: 1 }),
    ];
    const shuffled = [forward[2]!, forward[0]!, forward[1]!];

    expect(rankExisting(forward, "suspect", 10)).toEqual(["a", "b", "c"]);
    expect(rankExisting(shuffled, "suspect", 10)).toEqual(["a", "b", "c"]);
  });

  test("caps the result at max", () => {
    const setups = ["a", "b", "c", "d"].map((id) =>
      setup({ id, badRate: 0.2, costPerSession: 1 }),
    );
    expect(rankExisting(setups, "suspect", 2)).toEqual(["a", "b"]);
  });

  test("returns everything eligible when max exceeds the eligible count", () => {
    const setups = [setup({ id: "a" }), setup({ id: "b" })];
    expect(rankExisting(setups, "suspect", 25)).toEqual(["a", "b"]);
  });

  test("returns empty for a non-positive max, an empty roster, or nothing eligible", () => {
    const setups = [setup({ id: "a" }), setup({ id: "b" })];
    expect(rankExisting(setups, "suspect", 0)).toEqual([]);
    expect(rankExisting(setups, "suspect", -1)).toEqual([]);
    expect(rankExisting([], "suspect", 10)).toEqual([]);
    expect(rankExisting([setup({ id: "suspect" }), setup({ id: "thin", sessions: 1 })], "suspect", 10)).toEqual(
      [],
    );
  });

  test("does not mutate the caller's array", () => {
    const setups = [
      setup({ id: "b", badRate: 0.9, costPerSession: 9 }),
      setup({ id: "a", badRate: 0.1, costPerSession: 1 }),
    ];
    const before = setups.map((s) => s.id);

    rankExisting(setups, "suspect", 10);

    expect(setups.map((s) => s.id)).toEqual(before);
  });

  test("returns ids only, never the setup objects", () => {
    const setups = [setup({ id: "solo" })];
    expect(rankExisting(setups, "suspect", 10)).toEqual(["solo"]);
  });
});
