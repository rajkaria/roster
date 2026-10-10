import { describe, expect, test } from "bun:test";
import { explainGate, explainSuspect } from "../../src/cli/explain.ts";

describe("explainGate", () => {
  test("spells out failure codes F1-F7", () => {
    const cases = [
      ["F1", "edited existing tests"],
      ["F2", "never ran tests"],
      ["F3", "suite regression"],
      ["F4", "stopped early"],
      ["F5", "loop, timeout or turn cap"],
      ["F6", "environment or setup error; the task is excluded and resampled"],
      ["F7", "off-scope edits"],
    ] as const;

    for (const [code, phrase] of cases) {
      const output = explainGate({
        candidate: "candidate-setup",
        verdict: "reject",
        reasons: [code],
        regressions: [],
      });

      expect(output).toContain(phrase);
    }
  });

  test("names each regressed task on rejection", () => {
    const output = explainGate({
      candidate: "new-setup",
      verdict: "reject",
      reasons: ["F3"],
      regressions: ["task-alpha", "task-beta"],
    });

    expect(output).toContain("task-alpha");
    expect(output).toContain("task-beta");
  });
});

describe("explainSuspect", () => {
  test("suspect sentence contains suspect and observational, never worse", () => {
    const output = explainSuspect({
      setupId: "setup-42",
      or: 1.5,
      p: 0.04,
      n: 30,
      reason: "low odds ratio",
    });

    expect(output).toContain("suspect");
    expect(output).toContain("observational");
    expect(output).not.toContain("worse");
  });

  test("null setupId says no setup stands out plus reason", () => {
    const reason = "not enough mature sessions";

    const output = explainSuspect({
      setupId: null,
      n: 3,
      reason,
    });

    expect(output).toContain("No setup stands out");
    expect(output).toContain(reason);
  });
});
