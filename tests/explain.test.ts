import { describe, expect, test } from "bun:test";
import { explainGate, explainSuspect, FAILURE_PHRASES } from "../src/cli/explain.ts";
import { FailureCode } from "../src/types.ts";

const ALL_CODES = Object.values(FailureCode);

describe("explainGate", () => {
  test("spells out every failure code on its own", () => {
    for (const code of ALL_CODES) {
      const out = explainGate({ candidate: "cand", verdict: "reject", reasons: [code], regressions: [] });
      expect(out).toContain(FAILURE_PHRASES[code]);
      expect(out).toContain(code);
    }
  });

  test("spells out a code that sits inside a longer reason", () => {
    const out = explainGate({
      candidate: "cand",
      verdict: "reject",
      reasons: ["replay 3 flagged F1 and F7"],
      regressions: [],
    });
    expect(out).toContain("edited existing tests (F1)");
    expect(out).toContain("off-scope edits (F7)");
    expect(out).toContain("replay 3 flagged");
  });

  test("leaves a plain-language reason alone", () => {
    const out = explainGate({
      candidate: "cand",
      verdict: "reject",
      reasons: ["hidden_pass 1 < incumbent 2"],
      regressions: [],
    });
    expect(out).toContain("hidden_pass 1 < incumbent 2");
  });

  test("names every regressed task on rejection", () => {
    const out = explainGate({
      candidate: "new-setup",
      verdict: "reject",
      reasons: ["F3"],
      regressions: ["task-alpha", "task-beta"],
    });
    expect(out).toContain("task-alpha");
    expect(out).toContain("task-beta");
    expect(out).toContain("failed the gate");
  });

  test("a rejection with no regressions says so", () => {
    const out = explainGate({ candidate: "cand", verdict: "reject", reasons: ["F2"], regressions: [] });
    expect(out).toContain("No task that the current setup passes regressed");
  });

  test("a promotion reads as a promotion", () => {
    const out = explainGate({
      candidate: "cand",
      verdict: "promote",
      reasons: ["hidden_pass 4 > incumbent 2, 0 regressions, within budget"],
      regressions: [],
    });
    expect(out).toContain("cand passed the gate");
    expect(out).toContain("hidden_pass 4 > incumbent 2");
  });

  test("handles an empty reason list without inventing one", () => {
    const out = explainGate({ candidate: "cand", verdict: "promote", reasons: [], regressions: [] });
    expect(out).not.toContain("Why:");
    expect(out).toContain("cand passed the gate");
  });
});

describe("explainSuspect", () => {
  test("a flagged setup keeps suspect and observational, and never says worse", () => {
    const out = explainSuspect({ setupId: "setup-42", or: 1.5, p: 0.04, n: 30, reason: "low odds ratio" });
    expect(out).toContain("suspect");
    expect(out).toContain("observational");
    expect(out).not.toContain("worse");
    expect(out).toContain("setup-42");
    expect(out).toContain("low odds ratio");
    expect(out).toContain("1.50");
    expect(out).toContain("0.0400");
    expect(out).toContain("30 mature sessions");
  });

  test("a call without a matched comparison omits the numbers instead of guessing", () => {
    const out = explainSuspect({ setupId: "setup-1", n: 8, reason: "not enough mature sessions" });
    expect(out).toContain("setup-1");
    expect(out).toContain("8 mature sessions");
    expect(out).not.toContain("odds ratio");
    expect(out).not.toMatch(/p \d/);
  });

  test("no suspect says exactly that, with the reason", () => {
    const reason = "not enough mature sessions";
    const out = explainSuspect({ setupId: null, n: 3, reason });
    expect(out).toContain("No setup stands out");
    expect(out).toContain(reason);
    expect(out).toContain("observational");
    expect(out).not.toContain("worse");
    expect(out).toContain("3 mature sessions");
  });

  test("one session is singular", () => {
    const out = explainSuspect({ setupId: null, n: 1, reason: "one mature session only" });
    expect(out).toContain("1 mature session");
    expect(out).not.toContain("1 mature sessions");
  });
});
