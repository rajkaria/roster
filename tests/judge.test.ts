import { expect, test } from "bun:test";
import { blindPair, parseVerdict } from "../src/grade/judge";

const a = { setup: "setup-alpha", diff: "+ const a = 1; // setup-alpha" };
const b = { setup: "setup-beta", diff: "+ const b = 2;" };

test("prompt contains both diffs and no setup id", () => {
  for (let s = 0; s < 20; s++) {
    const { prompt, labels } = blindPair(a, b, s);
    expect(prompt).not.toContain("setup-alpha");
    expect(prompt).not.toContain("setup-beta");
    expect(prompt).toContain("const a = 1");
    expect(prompt).toContain("const b = 2");
    expect([labels.X, labels.Y].sort()).toEqual(["setup-alpha", "setup-beta"]);
  }
});

test("labels are deterministic per seed and both orders occur", () => {
  const seen = new Set<string>();
  for (let s = 0; s < 50; s++) {
    expect(blindPair(a, b, s)).toEqual(blindPair(a, b, s));
    seen.add(blindPair(a, b, s).labels.X);
  }
  expect(seen.size).toBe(2);
});

test("diff under X appears before diff under Y per labels", () => {
  const { prompt, labels } = blindPair(a, b, 3);
  const marker = (id: string) => (id === "setup-alpha" ? "const a = 1" : "const b = 2");
  expect(prompt.indexOf(marker(labels.X))).toBeLessThan(prompt.indexOf(marker(labels.Y)));
});

test("parseVerdict maps labels, case-insensitive, last wins", () => {
  const labels = { X: "s1", Y: "s2" };
  expect(parseVerdict("reasoning\nVERDICT: X", labels).winner).toBe("s1");
  expect(parseVerdict("verdict: y", labels).winner).toBe("s2");
  expect(parseVerdict("VERDICT: X\nmore\nVerdict: Tie\n", labels).winner).toBe("tie");
  expect(parseVerdict("VERDICT: TIE\nVERDICT: Y  ", labels).winner).toBe("s2");
});

test("parseVerdict returns unclear otherwise", () => {
  const labels = { X: "s1", Y: "s2" };
  expect(parseVerdict("", labels).winner).toBe("unclear");
  expect(parseVerdict("I prefer X", labels).winner).toBe("unclear");
  expect(parseVerdict("VERDICT: Z", labels).winner).toBe("unclear");
  expect(parseVerdict("VERDICT: X because it is better", labels).winner).toBe("unclear");
});
