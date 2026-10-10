import { describe, expect, test } from "bun:test";
import { blindPair, parseVerdict } from "../../src/grade/judge.ts";

const setupA = "setup-alpha";
const setupB = "setup-beta";
const diffA = "diff from alpha\nline2";
const diffB = "diff from beta\nline2";

describe("blindPair", () => {
  test("prompt contains both diffs under labels X and Y", () => {
    const result = blindPair(
      { setup: setupA, diff: diffA },
      { setup: setupB, diff: diffB },
      123,
    );

    expect(result.prompt).toContain("X");
    expect(result.prompt).toContain("Y");
    expect(result.prompt).toContain(diffA);
    expect(result.prompt).toContain(diffB);
  });

  test("prompt never contains either setup id", () => {
    const result = blindPair(
      { setup: setupA, diff: diffA },
      { setup: setupB, diff: diffB },
      123,
    );

    expect(result.prompt).not.toContain(setupA);
    expect(result.prompt).not.toContain(setupB);
  });

  test("labels map X and Y to the two setup ids", () => {
    const result = blindPair(
      { setup: setupA, diff: diffA },
      { setup: setupB, diff: diffB },
      123,
    );

    expect(result.labels).toHaveProperty("X");
    expect(result.labels).toHaveProperty("Y");
    expect([result.labels.X, result.labels.Y].sort()).toEqual([
      setupA,
      setupB,
    ].sort());
  });

  test("same seed gives the same assignment and prompt", () => {
    const a = { setup: setupA, diff: diffA };
    const b = { setup: setupB, diff: diffB };

    expect(blindPair(a, b, 42)).toEqual(blindPair(a, b, 42));
  });
});

describe("parseVerdict", () => {
  const labels = { X: setupA, Y: setupB };

  test("maps X back to the X setup id", () => {
    expect(parseVerdict("VERDICT: X", labels)).toEqual({ winner: setupA });
  });

  test("maps Y back to the Y setup id", () => {
    expect(parseVerdict("VERDICT: Y", labels)).toEqual({ winner: setupB });
  });

  test("maps TIE to tie", () => {
    expect(parseVerdict("VERDICT: TIE", labels)).toEqual({ winner: "tie" });
  });

  test("is case-insensitive", () => {
    expect(parseVerdict("verdict: x", labels)).toEqual({ winner: setupA });
    expect(parseVerdict("Verdict: y", labels)).toEqual({ winner: setupB });
    expect(parseVerdict("VERDICT: tie", labels)).toEqual({ winner: "tie" });
  });

  test("last occurrence wins", () => {
    expect(parseVerdict("VERDICT: X\nVERDICT: Y", labels)).toEqual({
      winner: setupB,
    });
    expect(parseVerdict("VERDICT: Y\nVERDICT: TIE", labels)).toEqual({
      winner: "tie",
    });
    expect(parseVerdict("VERDICT: TIE\nVERDICT: x", labels)).toEqual({
      winner: setupA,
    });
  });

  test("returns unclear for anything else", () => {
    expect(parseVerdict("no verdict here", labels)).toEqual({
      winner: "unclear",
    });
    expect(parseVerdict("", labels)).toEqual({ winner: "unclear" });
    expect(parseVerdict("VERDICT: Z", labels)).toEqual({
      winner: "unclear",
    });
    expect(parseVerdict("The winner is X", labels)).toEqual({
      winner: "unclear",
    });
  });
});
