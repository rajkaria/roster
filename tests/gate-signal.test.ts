import { describe, expect, test } from "bun:test";
import { gate, NO_SIGNAL_MIN_TASKS, NO_SIGNAL_REASON } from "../src/gate/index.ts";
import type { GateResults } from "../src/gate/index.ts";
import { FailureCode } from "../src/types.ts";

// Compact attempt notation per task: "P" pass, "F" fail, "J" judge-only (no hidden tests), "E" F6 env error.
type Spec = Record<string, string>;

function rows(spec: Spec, cost = 1): GateResults {
  const out: GateResults = [];
  for (const [task, attempts] of Object.entries(spec)) {
    [...attempts].forEach((a, i) => {
      out.push({
        task_session_id: task,
        attempt: i + 1,
        hidden_pass: a === "J" ? null : a === "P",
        scope_ok: true,
        cost_usd: cost,
        failure_codes: a === "E" ? [FailureCode.F6] : [],
      });
    });
  }
  return out;
}

const BUDGET = { budget: 100 };

describe("no_signal: the incumbent fails its own tasks", () => {
  test("incumbent 0 of 3 tests-track tasks → no_signal, nothing promoted", () => {
    const inc = rows({ t1: "F", t2: "F", t3: "F" }, 2);
    const cand = rows({ t1: "P", t2: "P", t3: "P" }, 0.1);
    const r = gate(inc, cand, BUDGET);
    expect(r.verdict).toBe("no_signal");
    expect(r.reasons[0]).toBe(NO_SIGNAL_REASON);
    expect(r.hidden_pass).toEqual({ incumbent: 0, candidate: 3 });
  });

  test("incumbent 0 of 3 on the candidate's 0–0 tie → still no_signal, never promote", () => {
    const r = gate(rows({ t1: "F", t2: "F", t3: "F" }, 2), rows({ t1: "F", t2: "F", t3: "F" }, 0.1), BUDGET);
    expect(r.verdict).toBe("no_signal");
    expect(r.ties).toBe("none");
  });

  test("the threshold is three tests-track tasks", () => {
    expect(NO_SIGNAL_MIN_TASKS).toBe(3);
    const r = gate(rows({ t1: "F", t2: "F" }, 2), rows({ t1: "F", t2: "F" }, 0.1), BUDGET);
    expect(r.verdict).toBe("reject");
    expect(r.reasons.join("\n")).not.toMatch(/no signal/);
  });

  test("judge-only tasks do not count toward the tests-track threshold", () => {
    const r = gate(rows({ t1: "F", t2: "J", t3: "J", t4: "J" }, 2), rows({ t1: "F", t2: "J", t3: "J", t4: "J" }, 0.1), BUDGET);
    expect(r.verdict).not.toBe("no_signal");
  });

  test("one incumbent pass among 3 tests-track tasks is a signal", () => {
    const r = gate(rows({ t1: "P", t2: "F", t3: "F" }, 2), rows({ t1: "P", t2: "F", t3: "F" }, 0.1), BUDGET);
    expect(r.verdict).toBe("promote");
  });

  test("a majority of attempts must pass, so a 1–1 incumbent split is no pass", () => {
    const r = gate(rows({ t1: "PF", t2: "F", t3: "F" }, 2), rows({ t1: "F", t2: "F", t3: "F" }, 0.1), BUDGET);
    expect(r.verdict).toBe("no_signal");
  });
});

describe("a 0–0 tie never promotes", () => {
  test("two tests-track tasks, both fail, candidate cheaper → reject, keep incumbent", () => {
    const r = gate(rows({ t1: "F", t2: "F" }, 2), rows({ t1: "F", t2: "F" }, 0.1), BUDGET);
    expect(r.verdict).toBe("reject");
    expect(r.ties).toBe("incumbent");
    expect(r.reasons.join("\n")).toMatch(/tie at 0 hidden passes/);
  });

  test("judge-only replay set, candidate cheaper → reject, not promote", () => {
    const r = gate(rows({ t1: "J" }, 2), rows({ t1: "J" }, 0.1), BUDGET);
    expect(r.verdict).toBe("reject");
    expect(r.ties).toBe("incumbent");
  });

  test("a non-zero tie still goes to the cheaper candidate", () => {
    const r = gate(rows({ t1: "P" }, 2), rows({ t1: "P" }, 0.1), BUDGET);
    expect(r.verdict).toBe("promote");
    expect(r.ties).toBe("cheaper");
  });

  test("a candidate that passes beats a 0–0 incumbent without the tie rule", () => {
    const r = gate(rows({ t1: "F" }, 2), rows({ t1: "P" }, 3), BUDGET);
    expect(r.verdict).toBe("promote");
  });
});

// Keeps the F6 notation honest: an all-F6 incumbent task is excluded, so it can't push the count to zero.
test("an all-F6 incumbent task is excluded from the no_signal count", () => {
  const inc = rows({ t1: "F", t2: "F", t3: "E" }, 2);
  const cand = rows({ t1: "F", t2: "F", t3: "F" }, 0.1);
  const r = gate(inc, cand, BUDGET);
  expect(r.excluded).toEqual(["t3"]);
  expect(r.verdict).toBe("reject");
});
