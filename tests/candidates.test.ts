import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ADDED_SECTION, loadRulesLib, proposeRulesCandidate } from "../src/candidates/index.ts";
import { FailureCode } from "../src/types.ts";

const BASE = ["# Rules", "", "## Working rules", "- Do only your task."].join("\n");
const BULLETS = (rules: string) =>
  rules
    .slice(rules.indexOf(ADDED_SECTION))
    .split("\n")
    .filter((l) => l.startsWith("- "));

describe("rules-lib.md", () => {
  test("maps F1, F2, F4, F5, F7 to one rule each and leaves F3, F6 unmapped", () => {
    const lib = loadRulesLib();
    expect(lib.size).toBe(5);
    expect(lib.get(FailureCode.F1)).toContain("never modify existing tests");
    expect(lib.get(FailureCode.F2)).toContain("full test suite");
    expect(lib.get(FailureCode.F4)).toContain("list anything skipped");
    expect(lib.get(FailureCode.F5)).toContain("more than twice");
    expect(lib.get(FailureCode.F7)).toContain("only files the task needs");
    expect(lib.has(FailureCode.F3)).toBe(false);
    expect(lib.has(FailureCode.F6)).toBe(false);
  });

  test("every key is a real FailureCode", () => {
    const known = new Set<string>(Object.values(FailureCode));
    for (const code of loadRulesLib().keys()) expect(known.has(code as string)).toBe(true);
  });
});

describe("proposeRulesCandidate", () => {
  test("no codes: base comes back byte for byte, nothing added", () => {
    const c = proposeRulesCandidate(BASE, []);
    expect(c.rules).toBe(BASE);
    expect(c.added).toEqual([]);
  });

  test("only unmapped codes F3 and F6: base unchanged, nothing added", () => {
    const c = proposeRulesCandidate(BASE, [FailureCode.F3, FailureCode.F6]);
    expect(c.rules).toBe(BASE);
    expect(c.added).toEqual([]);
  });

  test("appends the section and cites the code the rule answers", () => {
    const c = proposeRulesCandidate(BASE, [FailureCode.F2]);
    expect(c.rules.startsWith(BASE)).toBe(true);
    expect(c.rules).toContain(`${ADDED_SECTION}\n\n- run the full test suite before finishing (answers F2)\n`);
    expect(c.added).toEqual([{ rule: "run the full test suite before finishing", answers: [FailureCode.F2] }]);
  });

  test("base text survives intact for every input", () => {
    const inputs = [[FailureCode.F1], [FailureCode.F7, FailureCode.F4], Object.values(FailureCode)];
    for (const codes of inputs) {
      const c = proposeRulesCandidate(BASE, codes);
      expect(c.rules.slice(0, c.rules.indexOf(ADDED_SECTION)).trimEnd()).toBe(BASE);
    }
  });

  test("deduplicates codes", () => {
    const c = proposeRulesCandidate(BASE, [FailureCode.F1, FailureCode.F1, FailureCode.F1]);
    expect(c.added.length).toBe(1);
    expect(c.added[0]!.answers).toEqual([FailureCode.F1]);
    expect(c.rules.match(/answers F1/g)!.length).toBe(1);
    expect(BULLETS(c.rules).length).toBe(1);
  });

  test("a rule already present in the base is not added again, case-insensitively", () => {
    const base = `${BASE}\n- ALWAYS run the full test suite before finishing, every time.`;
    const c = proposeRulesCandidate(base, [FailureCode.F2, FailureCode.F7]);
    expect(c.rules.startsWith(base)).toBe(true);
    expect(c.added.map((a) => a.answers[0])).toEqual([FailureCode.F7]);
    expect(c.rules.match(/answers F2/)).toBeNull();
    expect(BULLETS(c.rules).length).toBe(1);
  });

  test("all five mapped codes: one bullet each, in the order given, F3/F6 silent", () => {
    const codes = [
      FailureCode.F7,
      FailureCode.F3,
      FailureCode.F2,
      FailureCode.F5,
      FailureCode.F6,
      FailureCode.F4,
      FailureCode.F1,
    ];
    const c = proposeRulesCandidate(BASE, codes);
    expect(c.added.map((a) => a.answers[0])).toEqual([
      FailureCode.F7,
      FailureCode.F2,
      FailureCode.F5,
      FailureCode.F4,
      FailureCode.F1,
    ]);
    const bullets = BULLETS(c.rules);
    expect(bullets.length).toBe(5);
    for (const a of c.added) expect(bullets).toContain(`- ${a.rule} (answers ${a.answers.join(", ")})`);
  });

  test("works on an empty base", () => {
    const c = proposeRulesCandidate("", [FailureCode.F4]);
    expect(c.rules.startsWith(ADDED_SECTION)).toBe(true);
    expect(c.added.length).toBe(1);
  });

  test("is pure, and does not mutate its input", () => {
    const codes = [FailureCode.F1, FailureCode.F5];
    const first = proposeRulesCandidate(BASE, codes);
    expect(proposeRulesCandidate(BASE, codes)).toEqual(first);
    expect(codes).toEqual([FailureCode.F1, FailureCode.F5]);
    expect(BASE).toBe(["# Rules", "", "## Working rules", "- Do only your task."].join("\n"));
  });

  test("on the repo's own default rules file every added rule is genuinely new", () => {
    const base = readFileSync("setups/rules/default.md", "utf8");
    const c = proposeRulesCandidate(base, Object.values(FailureCode));
    expect(c.rules.startsWith(base)).toBe(true);
    expect(c.added.length).toBeGreaterThan(0);
    for (const a of c.added) expect(base.toLowerCase()).not.toContain(a.rule.toLowerCase());
    expect(BULLETS(c.rules).length).toBe(c.added.length);
  });
});
