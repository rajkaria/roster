import { test, expect } from "bun:test";
import { sampleTasks } from "../../src/replay/sample";

function makeTasks(
  specs: Array<[id: string, tercile: 1 | 2 | 3, eligible?: boolean]>
) {
  return specs.map(([id, tercile, eligible = true]) => ({ id, tercile, eligible }));
}

function countByTercile(
  tasks: { id: string; tercile: 1 | 2 | 3; eligible: boolean }[],
  output: string[]
): Record<number, number> {
  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
  const idToTercile = new Map(tasks.map((t) => [t.id, t.tercile]));
  for (const id of output) {
    const tercile = idToTercile.get(id);
    if (tercile !== undefined) counts[tercile]++;
  }
  return counts;
}

test("returns only eligible tasks, sorted by id", () => {
  const tasks = makeTasks([
    ["a", 1],
    ["b", 1, false],
    ["c", 2],
    ["d", 3],
    ["e", 2, false],
    ["f", 1],
  ]);
  const eligibleIds = tasks
    .filter((t) => t.eligible)
    .map((t) => t.id)
    .sort();

  // max >= number of eligible tasks → all eligible tasks, sorted
  const resultAll = sampleTasks(tasks, { max: 10, seed: 123 });
  expect(resultAll).toEqual(eligibleIds);

  // max < number of eligible tasks → output is a sorted subset of eligible tasks
  const resultSubset = sampleTasks(tasks, { max: 3, seed: 123 });
  expect(resultSubset).toHaveLength(3);
  expect([...resultSubset].sort()).toEqual(resultSubset); // sorted
  for (const id of resultSubset) {
    expect(eligibleIds).toContain(id);
  }
});

test("same input and seed produce identical output", () => {
  const tasks = makeTasks([
    ["a1", 1],
    ["a2", 1],
    ["a3", 1],
    ["b1", 2],
    ["b2", 2],
    ["b3", 2],
    ["c1", 3],
    ["c2", 3],
    ["c3", 3],
  ]);
  const first = sampleTasks(tasks, { max: 6, seed: 999 });
  const second = sampleTasks(tasks, { max: 6, seed: 999 });
  expect(first).toEqual(second);
});

test("allocates max evenly across terciles when all have enough tasks", () => {
  const tasks = makeTasks([
    ["a1", 1],
    ["a2", 1],
    ["a3", 1],
    ["b1", 2],
    ["b2", 2],
    ["b3", 2],
    ["c1", 3],
    ["c2", 3],
    ["c3", 3],
  ]);
  const result = sampleTasks(tasks, { max: 6, seed: 42 });
  const counts = countByTercile(tasks, result);
  expect(counts[1]).toBe(2);
  expect(counts[2]).toBe(2);
  expect(counts[3]).toBe(2);
});

test("gives remainder to the highest tercile when allocating uneven max", () => {
  const tasks = makeTasks([
    ["a1", 1],
    ["a2", 1],
    ["a3", 1],
    ["a4", 1],
    ["b1", 2],
    ["b2", 2],
    ["b3", 2],
    ["b4", 2],
    ["c1", 3],
    ["c2", 3],
    ["c3", 3],
    ["c4", 3],
  ]);
  const result = sampleTasks(tasks, { max: 7, seed: 7 });
  const counts = countByTercile(tasks, result);
  // base = 2 per tercile, remainder 1 goes to tercile 3 (highest)
  expect(counts[1]).toBe(2);
  expect(counts[2]).toBe(2);
  expect(counts[3]).toBe(3);
});

test("fills a short tercile's leftover from other terciles", () => {
  // tercile 2 has exactly 2 eligible tasks; tercile 1 has many; tercile 3 has none
  const tasks = makeTasks([
    ["a1", 1],
    ["a2", 1],
    ["a3", 1],
    ["a4", 1],
    ["a5", 1],
    ["a6", 1],
    ["a7", 1],
    ["a8", 1],
    ["a9", 1],
    ["a10", 1],
    ["b1", 2],
    ["b2", 2],
  ]);
  const result = sampleTasks(tasks, { max: 5, seed: 123 });
  const counts = countByTercile(tasks, result);
  // Available terciles: 1 (10 tasks) and 2 (2 tasks).
  // Even allocation: base = floor(5/2) = 2, rem = 1 → highest available (tercile 2) gets extra.
  // Initial targets: t1=2, t2=3. t2 is short by 1 → leftover filled from t1.
  // Final: t1=3, t2=2, t3=0.
  expect(counts[1]).toBe(3);
  expect(counts[2]).toBe(2);
  expect(counts[3]).toBe(0);
  // All selected ids from tercile 2 are exactly its two eligible tasks
  const t2Selected = result.filter((id) => tasks.find((t) => t.id === id)?.tercile === 2);
  expect(t2Selected.sort()).toEqual(["b1", "b2"]);
});
