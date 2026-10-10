import { describe, expect, test } from "bun:test";
import { proposeRulesCandidate } from "../../../src/candidates/index.ts";
import { FailureCode } from "../../../src/types.ts";

describe("proposeRulesCandidate", () => {
  test("empty codes returns base rules unchanged and no additions", () => {
    const base = "# Rules\n- Keep this line";
    const result = proposeRulesCandidate(base, []);

    expect(result.rules).toBe(base);
    expect(result.added).toEqual([]);
  });

  test("maps F1, F2, F4, F5 and F7 to their rules and cites the codes", () => {
    const result = proposeRulesCandidate("", [
      FailureCode.F1,
      FailureCode.F2,
      FailureCode.F4,
      FailureCode.F5,
      FailureCode.F7,
    ]);

    expect(result.added).toEqual([
      { rule: "never modify existing tests unless asked", answers: [FailureCode.F1] },
      { rule: "run the full test suite before finishing", answers: [FailureCode.F2] },
      { rule: "finish the whole task and list anything skipped", answers: [FailureCode.F4] },
      {
        rule: "stop and report instead of retrying the same failing step more than twice",
        answers: [FailureCode.F5],
      },
      { rule: "touch only files the task needs", answers: [FailureCode.F7] },
    ]);
  });

  test("F3 and F6 add nothing", () => {
    const result = proposeRulesCandidate("", [
      FailureCode.F3,
      FailureCode.F6,
      FailureCode.F1,
    ]);

    expect(result.added).toEqual([
      { rule: "never modify existing tests unless asked", answers: [FailureCode.F1] },
    ]);
  });

  test("deduplicates failure codes", () => {
    const result = proposeRulesCandidate("", [
      FailureCode.F1,
      FailureCode.F1,
      FailureCode.F2,
      FailureCode.F1,
    ]);

    expect(result.added).toEqual([
      { rule: "never modify existing tests unless asked", answers: [FailureCode.F1] },
      { rule: "run the full test suite before finishing", answers: [FailureCode.F2] },
    ]);
  });

  test("does not re-add a rule already present case-insensitive as a substring", () => {
    const base = "NEVER MODIFY EXISTING TESTS unless asked";
    const result = proposeRulesCandidate(base, [FailureCode.F1]);

    expect(result.added).toEqual([]);
    expect(result.rules.startsWith(base)).toBe(true);
  });

  test("appends the Added by Roster section without changing the base text", () => {
    const base = "# Base Rules\n\n- Always be careful";
    const result = proposeRulesCandidate(base, [FailureCode.F4]);

    expect(result.rules.startsWith(base)).toBe(true);
    expect(result.rules).toContain("## Added by Roster");
    expect(result.rules).toContain("finish the whole task and list anything skipped");
  });
});
