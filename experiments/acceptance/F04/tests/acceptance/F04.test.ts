import { describe, expect, it } from "bun:test";
import { detect } from "../../src/obs/detections.ts";

function summarize(results: ReturnType<typeof detect>) {
  return results.map(r => {
    const out: { id: string; setup?: string; task?: string } = { id: r.id };
    if (r.setup !== undefined) out.setup = r.setup;
    if (r.task !== undefined) out.task = r.task;
    return out;
  });
}

describe("detections F04", () => {
  it("detects D1 silent passes", () => {
    const input = {
      replays: [
        { task: "t1", setup: "s1", suitePass: true, hiddenPass: false, scopeOk: true, costUsd: null, failureCodes: [] },
        { task: "t2", setup: "s1", suitePass: true, hiddenPass: true, scopeOk: false, costUsd: null, failureCodes: [] },
        { task: "t3", setup: "s2", suitePass: true, hiddenPass: false, scopeOk: false, costUsd: null, failureCodes: [] },
        { task: "t4", setup: "s1", suitePass: true, hiddenPass: true, scopeOk: true, costUsd: null, failureCodes: [] },
        { task: "t5", setup: "s1", suitePass: false, hiddenPass: false, scopeOk: false, costUsd: null, failureCodes: [] },
      ],
      incumbent: "s1",
      unmappedLineShare: { s1: 0, s2: 0 },
    };

    const result = detect(input);

    expect(summarize(result)).toEqual([
      { id: "D1", setup: "s1", task: "t1" },
      { id: "D1", setup: "s1", task: "t2" },
      { id: "D1", setup: "s2", task: "t3" },
    ]);
    for (const d of result) expect(typeof d.detail).toBe("string");
  });

  it("detects D2 unmapped line share over threshold", () => {
    const input = {
      replays: [],
      incumbent: "inc",
      unmappedLineShare: { a: 0.31, b: 0.3, c: 0.3000001, d: 0.0, e: 0.301 },
    };

    const result = detect(input);

    expect(summarize(result)).toEqual([
      { id: "D2", setup: "a" },
      { id: "D2", setup: "c" },
      { id: "D2", setup: "e" },
    ]);
    for (const d of result) expect(typeof d.detail).toBe("string");
  });

  it("detects D3 high cost relative to incumbent median", () => {
    const input = {
      replays: [
        { task: "base1", setup: "inc", suitePass: false, hiddenPass: true, scopeOk: true, costUsd: 10, failureCodes: [] },
        { task: "base2", setup: "inc", suitePass: false, hiddenPass: true, scopeOk: true, costUsd: 20, failureCodes: [] },
        { task: "base3", setup: "inc", suitePass: false, hiddenPass: true, scopeOk: true, costUsd: 30, failureCodes: [] },
        { task: "base_null", setup: "inc", suitePass: false, hiddenPass: true, scopeOk: true, costUsd: null, failureCodes: [] },
        { task: "high1", setup: "s1", suitePass: false, hiddenPass: true, scopeOk: true, costUsd: 61, failureCodes: [] },
        { task: "exact", setup: "s1", suitePass: false, hiddenPass: true, scopeOk: true, costUsd: 60, failureCodes: [] },
        { task: "high_inc", setup: "inc", suitePass: false, hiddenPass: true, scopeOk: true, costUsd: 70, failureCodes: [] },
        { task: "high2", setup: "s2", suitePass: false, hiddenPass: true, scopeOk: true, costUsd: 100, failureCodes: [] },
        { task: "null_cost", setup: "s3", suitePass: false, hiddenPass: true, scopeOk: true, costUsd: null, failureCodes: [] },
      ],
      incumbent: "inc",
      unmappedLineShare: { inc: 0, s1: 0, s2: 0, s3: 0 },
    };

    const result = detect(input);

    expect(summarize(result)).toEqual([
      { id: "D3", setup: "inc", task: "high_inc" },
      { id: "D3", setup: "s1", task: "high1" },
      { id: "D3", setup: "s2", task: "high2" },
    ]);
    for (const d of result) expect(typeof d.detail).toBe("string");
  });

  it("emits no D3 when incumbent has no cost values", () => {
    const input = {
      replays: [
        { task: "t1", setup: "s1", suitePass: false, hiddenPass: true, scopeOk: true, costUsd: 1000, failureCodes: [] },
        { task: "t2", setup: "inc", suitePass: false, hiddenPass: true, scopeOk: true, costUsd: null, failureCodes: [] },
      ],
      incumbent: "inc",
      unmappedLineShare: { s1: 0, inc: 0 },
    };

    const result = detect(input);

    expect(summarize(result)).toEqual([]);
  });

  it("detects D4 when same task has F6 in at least two distinct setups", () => {
    const input = {
      replays: [
        { task: "taskA", setup: "s1", suitePass: false, hiddenPass: true, scopeOk: true, costUsd: null, failureCodes: ["F6"] },
        { task: "taskA", setup: "s2", suitePass: false, hiddenPass: true, scopeOk: true, costUsd: null, failureCodes: ["F6"] },
        { task: "taskA", setup: "s1", suitePass: false, hiddenPass: true, scopeOk: true, costUsd: null, failureCodes: ["F6"] },
        { task: "taskB", setup: "x", suitePass: false, hiddenPass: true, scopeOk: true, costUsd: null, failureCodes: ["F6"] },
        { task: "taskB", setup: "y", suitePass: false, hiddenPass: true, scopeOk: true, costUsd: null, failureCodes: ["F6"] },
        { task: "taskB", setup: "z", suitePass: false, hiddenPass: true, scopeOk: true, costUsd: null, failureCodes: ["F6"] },
        { task: "taskC", setup: "s1", suitePass: false, hiddenPass: true, scopeOk: true, costUsd: null, failureCodes: ["F6"] },
        { task: "taskD", setup: "s1", suitePass: false, hiddenPass: true, scopeOk: true, costUsd: null, failureCodes: ["F1"] },
        { task: "taskE", setup: "s1", suitePass: false, hiddenPass: true, scopeOk: true, costUsd: null, failureCodes: ["F6"] },
        { task: "taskE", setup: "s2", suitePass: false, hiddenPass: true, scopeOk: true, costUsd: null, failureCodes: ["F1"] },
      ],
      incumbent: "inc",
      unmappedLineShare: { s1: 0, s2: 0, x: 0, y: 0, z: 0, inc: 0 },
    };

    const result = detect(input);

    expect(summarize(result)).toEqual([
      { id: "D4", task: "taskA" },
      { id: "D4", task: "taskB" },
    ]);
    for (const d of result) expect(typeof d.detail).toBe("string");
  });

  it("sorts detections by id, setup, and task", () => {
    const input = {
      replays: [
        { task: "d1_task_b", setup: "b", suitePass: true, hiddenPass: false, scopeOk: true, costUsd: null, failureCodes: [] },
        { task: "d1_task_a", setup: "a", suitePass: true, hiddenPass: true, scopeOk: false, costUsd: null, failureCodes: [] },
        { task: "inc1", setup: "inc", suitePass: false, hiddenPass: true, scopeOk: true, costUsd: 10, failureCodes: [] },
        { task: "inc2", setup: "inc", suitePass: false, hiddenPass: true, scopeOk: true, costUsd: 20, failureCodes: [] },
        { task: "inc3", setup: "inc", suitePass: false, hiddenPass: true, scopeOk: true, costUsd: 30, failureCodes: [] },
        { task: "high", setup: "a", suitePass: false, hiddenPass: true, scopeOk: true, costUsd: 61, failureCodes: [] },
        { task: "m", setup: "s1", suitePass: false, hiddenPass: true, scopeOk: true, costUsd: null, failureCodes: ["F6"] },
        { task: "m", setup: "s2", suitePass: false, hiddenPass: true, scopeOk: true, costUsd: null, failureCodes: ["F6"] },
      ],
      incumbent: "inc",
      unmappedLineShare: { z: 0.35, a: 0.31 },
    };

    const result = detect(input);

    expect(summarize(result)).toEqual([
      { id: "D1", setup: "a", task: "d1_task_a" },
      { id: "D1", setup: "b", task: "d1_task_b" },
      { id: "D2", setup: "a" },
      { id: "D2", setup: "z" },
      { id: "D3", setup: "a", task: "high" },
      { id: "D4", task: "m" },
    ]);
    for (const d of result) expect(typeof d.detail).toBe("string");
  });
});
