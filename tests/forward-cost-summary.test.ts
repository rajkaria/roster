import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { forwardCost, median } from "../scripts/forward-cost";

const ROOT = join(import.meta.dir, "..");

test("median of odd, even and empty lists", () => {
  expect(median([3, 1, 2])).toBe(2);
  expect(median([4, 1, 3, 2])).toBe(2.5);
  expect(median([])).toBeNull();
});

test("excluded and unpriced rows are left out of the cost comparison", () => {
  const c = forwardCost({
    rows: [
      { task: "a", costOld: 0.3, costNew: 0.1 },
      { task: "b", costOld: 0.1, costNew: 0.2 },
      { task: "c", costOld: 0.5, costNew: 0.01 },
      { task: "x", costOld: 9, costNew: 0.001, excluded: "F6" },
      { task: "u", costOld: null, costNew: 0.1 },
    ],
    cost_p: 0.04,
  });
  expect(c).toEqual({ source: "reports/self/forward.json", pairs: 3, cheaperNew: 2, medianNewUsd: 0.1, medianOldUsd: 0.3, wilcoxonP: 0.04 });
});

test("the committed forward-cost.json matches forward.json", () => {
  const forward = JSON.parse(readFileSync(join(ROOT, "reports/self/forward.json"), "utf8"));
  const committed = JSON.parse(readFileSync(join(ROOT, "reports/self/forward-cost.json"), "utf8"));
  expect(committed).toEqual(forwardCost(forward));
  expect(committed.pairs).toBe(forward.summary.n);
});
