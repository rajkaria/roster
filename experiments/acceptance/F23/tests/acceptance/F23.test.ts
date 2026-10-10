import { describe, test, expect } from "bun:test";
import { nextSteps } from "../../src/agent/resume.ts";

const plan = (steps: { key: string; dependsOn: string[] }[]) => ({ steps });
const ev = (key: string, status: "started" | "done" | "failed") => ({ key, status });

describe("nextSteps", () => {
  test("returns ready keys in plan order", () => {
    const p = plan([
      { key: "second", dependsOn: [] },
      { key: "first", dependsOn: [] },
      { key: "third", dependsOn: [] },
    ]);

    expect(nextSteps(p, [])).toEqual(["second", "first", "third"]);
  });

  test("requires every dependency to be done", () => {
    const p = plan([
      { key: "a", dependsOn: [] },
      { key: "b", dependsOn: ["a"] },
      { key: "c", dependsOn: ["a", "b"] },
    ]);

    const events = [ev("a", "done"), ev("b", "done")];

    expect(nextSteps(p, events)).toEqual(["c"]);
  });

  test("does not return a done step", () => {
    const p = plan([{ key: "a", dependsOn: [] }]);

    expect(nextSteps(p, [ev("a", "done")])).toEqual([]);
  });

  test("returns an unfinished started step again", () => {
    const p = plan([
      { key: "a", dependsOn: [] },
      { key: "b", dependsOn: ["a"] },
    ]);

    expect(nextSteps(p, [ev("a", "started")])).toEqual(["a"]);
  });

  test("returns a failed step again until it has three failures", () => {
    const p = plan([{ key: "a", dependsOn: [] }]);

    expect(nextSteps(p, [ev("a", "failed")])).toEqual(["a"]);
    expect(nextSteps(p, [ev("a", "failed"), ev("a", "failed")])).toEqual(["a"]);
    expect(
      nextSteps(p, [ev("a", "failed"), ev("a", "failed"), ev("a", "failed")]),
    ).toEqual([]);
  });

  test("excludes a triple-failed step and its dependents", () => {
    const p = plan([
      { key: "a", dependsOn: [] },
      { key: "b", dependsOn: ["a"] },
      { key: "c", dependsOn: ["b"] },
    ]);

    const events = [
      ev("a", "failed"),
      ev("a", "failed"),
      ev("a", "failed"),
    ];

    expect(nextSteps(p, events)).toEqual([]);
  });
});
