import { describe, expect, test } from "bun:test";

import { sampleTasks, type SampleTask } from "../src/replay/sample.ts";

/** `n` eligible tasks in one tercile, ids `t<tercile>-01…`. */
function tercile(n: number, tercile: 1 | 2 | 3, eligible = true): SampleTask[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${tercile}-${String(i + 1).padStart(2, "0")}`,
    tercile,
    eligible,
  }));
}

const counts = (ids: string[], tasks: SampleTask[]): Record<string, number> => {
  const of = new Map(tasks.map((t) => [t.id, t.tercile]));
  const out = { "1": 0, "2": 0, "3": 0 };
  for (const id of ids) {
    const t = of.get(id);
    if (t === undefined) throw new Error(`sampler returned unknown id ${id}`);
    out[String(t) as keyof typeof out]++;
  }
  return out;
};

const tasks = [...tercile(10, 1), ...tercile(10, 2), ...tercile(10, 3)];

describe("sampleTasks", () => {
  test("only eligible tasks come back", () => {
    const mixed = [...tercile(4, 1), ...tercile(6, 2, false), ...tercile(4, 3)];
    const got = sampleTasks(mixed, { max: 12, seed: 1 });
    expect(got.sort()).toEqual([...tercile(4, 1), ...tercile(4, 3)].map((t) => t.id).sort());
    expect(got).not.toContain("t2-01");
  });

  test("all ineligible → empty", () => {
    const mixed = [...tercile(5, 1, false), ...tercile(5, 2, false), ...tercile(5, 3, false)];
    expect(sampleTasks(mixed, { max: 4, seed: 7 })).toEqual([]);
  });

  test("no tasks → empty, max ≤ 0 → empty", () => {
    expect(sampleTasks([], { max: 12, seed: 1 })).toEqual([]);
    expect(sampleTasks(tasks, { max: 0, seed: 1 })).toEqual([]);
    expect(sampleTasks(tasks, { max: -3, seed: 1 })).toEqual([]);
  });

  test("splits max evenly across terciles", () => {
    for (const max of [3, 6, 9, 12, 30]) {
      expect(sampleTasks(tasks, { max, seed: 42 })).toHaveLength(max);
      expect(counts(sampleTasks(tasks, { max, seed: 42 }), tasks)).toEqual({ "1": max / 3, "2": max / 3, "3": max / 3 });
    }
  });

  test("remainder goes to the highest terciles first", () => {
    expect(counts(sampleTasks(tasks, { max: 10, seed: 3 }), tasks)).toEqual({ "1": 3, "2": 3, "3": 4 });
    expect(counts(sampleTasks(tasks, { max: 11, seed: 3 }), tasks)).toEqual({ "1": 3, "2": 4, "3": 4 });
  });

  test("a short tercile's leftover is filled from the others", () => {
    const short = [...tercile(1, 1), ...tercile(10, 2), ...tercile(10, 3)];
    // base 3 each + remainder 1 to tercile 3; tercile 1 can only give 1, so its 2 spare slots go to 3 then 2.
    expect(counts(sampleTasks(short, { max: 10, seed: 5 }), short)).toEqual({ "1": 1, "2": 4, "3": 5 });
  });

  test("leftover stays inside the terciles that have capacity", () => {
    const short = [...tercile(1, 1), ...tercile(2, 2), ...tercile(20, 3)];
    const got = sampleTasks(short, { max: 12, seed: 5 });
    expect(got).toHaveLength(12);
    expect(counts(got, short)).toEqual({ "1": 1, "2": 2, "3": 9 });
  });

  test("never returns more than the eligible pool holds", () => {
    const small = [...tercile(2, 1), ...tercile(1, 2), ...tercile(3, 3)];
    const got = sampleTasks(small, { max: 12, seed: 9 });
    expect(got.sort()).toEqual(small.map((t) => t.id).sort());
    expect(new Set(got).size).toBe(got.length);
  });

  test("output is sorted by id", () => {
    const got = sampleTasks([...tercile(8, 1), ...tercile(8, 2), ...tercile(8, 3)], { max: 9, seed: 11 });
    expect(got).toEqual([...got].sort());
  });

  test("same input and seed → same output", () => {
    const seed = 2026;
    const first = sampleTasks(tasks, { max: 12, seed });
    expect(sampleTasks(tasks, { max: 12, seed })).toEqual(first);
    expect(sampleTasks([...tasks].reverse(), { max: 12, seed })).toEqual(first);
  });

  test("a different seed picks a different sample", () => {
    const samples = new Set(Array.from({ length: 16 }, (_, s) => sampleTasks(tasks, { max: 6, seed: s }).join(",")));
    expect(samples.size).toBeGreaterThan(1);
  });

  test("max smaller than the pool draws from the shuffled front of each tercile", () => {
    const got = sampleTasks(tasks, { max: 3, seed: 4 });
    expect(got).toHaveLength(3);
    expect(counts(got, tasks)).toEqual({ "1": 1, "2": 1, "3": 1 });
  });
});
