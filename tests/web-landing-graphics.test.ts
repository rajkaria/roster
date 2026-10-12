// The landing page's graphics: the scoreboard, the task grid, the cost chart and the roster cards.
// Fixtures are the real published reports under reports/, then copies altered to odd values, so every assertion
// shows the drawn numbers come from the files and agree with the published summaries.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FORWARD_SETUPS,
  axisMax,
  formatGenerated,
  frozenTasks,
  parseExclusions,
  passedBy,
  prettyModel,
  rosterCards,
  shortReason,
  sumSessions,
  taskGrid,
  taskGridFile,
} from "../web/lib/landing.ts";
import type { Review } from "../web/lib/types.ts";

const ROOT = join(import.meta.dir, "..");
const SELF = join(ROOT, "reports", "self");
const real = (p: string) => JSON.parse(readFileSync(join(SELF, p), "utf8"));
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

describe("taskGrid on the published run", () => {
  const forward = real("forward.json");
  const exclusions = real("forward-exclusions.json");
  const cost = real("forward-cost.json");
  const grid = taskGrid(forward, exclusions, cost);

  test("every frozen task gets one cell: recorded rows plus tasks excluded before pairing", () => {
    const tasks = new Set<string>([...forward.rows.map((r: { task: string }) => r.task), ...exclusions.exclusions.map((e: { task: string }) => e.task)]);
    expect(grid.cells.length).toBe(tasks.size);
    expect(frozenTasks(grid)).toBe(forward.pairs.recorded + forward.unmatched_exclusions.length);
  });

  test("the grid's counts sum-check against the published McNemar summary", () => {
    expect(grid.counts.newOnly).toBe(forward.summary.newOnly);
    expect(grid.counts.oldOnly).toBe(forward.summary.oldOnly);
    expect(grid.counts.both).toBe(forward.summary.both);
    expect(grid.counts.neither).toBe(forward.summary.neither);
    expect(grid.counts.excluded).toBe(exclusions.exclusions.length);
    expect(passedBy(grid.counts).valid).toBe(forward.summary.n);
  });

  test("cells are in task-number order and excluded cells carry a short reason and their amendment", () => {
    const nums = grid.cells.map((c) => Number(c.task.slice(1)));
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
    for (const e of exclusions.exclusions) {
      const c = grid.cells.find((x) => x.task === e.task)!;
      expect(c.outcome).toBe("excluded");
      expect(c.reason!.length).toBeGreaterThan(0);
      expect(c.amendment).toBe(e.amendment);
    }
  });

  test("the cost chart's pairs agree with forward-cost.json: count, cheaper count and both medians", () => {
    expect(grid.costPairs.length).toBe(cost.pairs);
    expect(grid.costPairs.filter((p) => p.new < p.old).length).toBe(cost.cheaperNew);
    expect(median(grid.costPairs.map((p) => p.new))).toBeCloseTo(cost.medianNewUsd, 9);
    expect(median(grid.costPairs.map((p) => p.old))).toBeCloseTo(cost.medianOldUsd, 9);
    expect(grid.cost).toEqual({ pairs: cost.pairs, cheaperNew: cost.cheaperNew, medianNew: cost.medianNewUsd, medianOld: cost.medianOldUsd, p: cost.wilcoxonP });
  });

  test("cost pairs run from the most expensive old run down, and exclude excluded tasks", () => {
    const olds = grid.costPairs.map((p) => p.old);
    expect(olds).toEqual([...olds].sort((a, b) => b - a));
    const excluded = new Set(exclusions.exclusions.map((e: { task: string }) => e.task));
    expect(grid.costPairs.some((p) => excluded.has(p.task))).toBe(false);
  });

  test("taskGridFile reads the same three files", () => {
    const fromDisk = taskGridFile(join(ROOT, "reports"));
    expect(fromDisk.counts).toEqual(grid.counts);
    expect(fromDisk.costPairs).toEqual(grid.costPairs);
  });
});

describe("taskGrid on altered copies", () => {
  test("outcomes and costs come from the rows", () => {
    const f = {
      rows: [
        { task: "F09", old: true, new: false, costOld: 0.5, costNew: 0.25 },
        { task: "F02", old: false, new: true, costOld: 0.75, costNew: 0.125 },
        { task: "F10", old: false, new: false, costOld: null, costNew: 0.1 },
      ],
      summary: { n: 3, wording: "W" },
    };
    const g = taskGrid(f, { exclusions: [{ task: "F01", reason: "network outage", amendment: 77 }] }, null);
    expect(g.cells.map((c) => [c.task, c.outcome])).toEqual([
      ["F01", "excluded"],
      ["F02", "newOnly"],
      ["F09", "oldOnly"],
      ["F10", "neither"],
    ]);
    expect(g.cells[0]!.amendment).toBe(77);
    // F10 has no old cost, so it is not on the cost chart.
    expect(g.costPairs).toEqual([
      { task: "F02", old: 0.75, new: 0.125 },
      { task: "F09", old: 0.5, new: 0.25 },
    ]);
    expect(g.cost).toBeNull();
  });

  test("a recorded row that is listed as excluded becomes an excluded cell", () => {
    const g = taskGrid({ rows: [{ task: "F04", old: false, new: false, costOld: 1, costNew: 1 }] }, { exclusions: [{ task: "F04", reason: "F6: inherited base test x" }] }, undefined);
    expect(g.cells[0]!.outcome).toBe("excluded");
    expect(g.counts.neither).toBe(0);
    expect(g.costPairs).toEqual([]);
  });

  test("missing files give an empty grid, never invented cells", () => {
    const g = taskGrid(undefined, undefined, undefined);
    expect(g.cells).toEqual([]);
    expect(g.costPairs).toEqual([]);
    expect(g.cost).toBeNull();
  });

  test("malformed exclusions and cost summaries are ignored", () => {
    expect(parseExclusions({ exclusions: [{ task: 3 }, { task: "F1" }, { task: "F2", reason: "r", amendment: "x" }] })).toEqual([{ task: "F2", reason: "r" }]);
    expect(parseExclusions(null)).toEqual([]);
    expect(taskGrid({ rows: [] }, null, { pairs: "35" }).cost).toBeNull();
  });
});

describe("helpers", () => {
  test("shortReason keeps the gist of the published reasons", () => {
    expect(shortReason("network outage: both sessions ended after 1 turn")).toBe("network outage, excluded for both sides");
    expect(shortReason("F6: inherited base test tests/agent-backend.test.ts (bd90b27), amendment 18")).toBe(
      "both sides failed only on a test inherited from the base commit",
    );
    expect(shortReason("F6: something else")).toBe("something else");
  });

  test("axisMax rounds the largest cost up to the step", () => {
    expect(axisMax([{ task: "a", old: 0.369, new: 0.1 }], 0.1)).toBeCloseTo(0.4, 9);
    expect(axisMax([{ task: "a", old: 0.3, new: 0.1 }], 0.1)).toBeCloseTo(0.3, 9);
    expect(axisMax([], 0.1)).toBeCloseTo(0.1, 9);
  });

  test("prettyModel", () => {
    expect(prettyModel("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(prettyModel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(prettyModel("deepseek-flash")).toBe("DeepSeek Flash");
    expect(prettyModel("deepseek-v4-pro")).toBe("DeepSeek V4 Pro");
    expect(prettyModel("gpt-x")).toBe("gpt-x");
  });

  test("sumSessions", () => {
    expect(sumSessions([{ sessions: 2 }, { sessions: 5 }])).toBe(7);
    expect(sumSessions([])).toBe(0);
  });
});

describe("FORWARD_SETUPS", () => {
  test("names match the setup files the forward run used", () => {
    const b = JSON.parse(readFileSync(join(ROOT, "setups", "B.json"), "utf8"));
    const e = JSON.parse(readFileSync(join(ROOT, "setups", "candidates", "E.json"), "utf8"));
    expect(b.id).toBe(FORWARD_SETUPS.old.id);
    expect(e.id).toBe(FORWARD_SETUPS.new.id);
    expect(b.label).toContain(FORWARD_SETUPS.old.name);
    expect(e.label).toContain(FORWARD_SETUPS.new.name);
    expect(prettyModel(b.model)).toBe(FORWARD_SETUPS.old.name);
    expect(prettyModel(e.model)).toBe(FORWARD_SETUPS.new.name);
  });

  test("the promoted setup is the one review 1 promoted", () => {
    expect(real("review-1/decisions.json").promoted).toBe(FORWARD_SETUPS.new.id);
  });
});

describe("rosterCards on the published review", () => {
  const review: Review = JSON.parse(readFileSync(join(ROOT, "reports", "rajkaria__roster", "review.json"), "utf8"));
  const cards = rosterCards(review);

  test("one card per setup in file order, sessions from the file, shares summing to one", () => {
    expect(cards.map((c) => c.setup_id)).toEqual(review.setups.map((s) => s.setup_id));
    expect(cards.map((c) => c.sessions)).toEqual(review.setups.map((s) => s.sessions));
    expect(cards.reduce((n, c) => n + c.share, 0)).toBeCloseTo(1, 9);
  });

  test("exactly one card is marked cheapest, and it has the lowest cost per surviving change", () => {
    const best = cards.filter((c) => c.cheapest);
    expect(best.length).toBe(1);
    const min = Math.min(...review.setups.filter((s) => s.mature_sessions > 0 && s.cost_per_surviving_change !== null).map((s) => s.cost_per_surviving_change!));
    expect(best[0]!.costPerSurviving).toBe(min);
  });

  test("a setup with no mature sessions is never marked cheapest", () => {
    const s0 = { ...review.setups[0]!, mature_sessions: 0, cost_per_surviving_change: 0.0001 };
    const altered = rosterCards({ ...review, setups: [s0, ...review.setups.slice(1)] });
    expect(altered[0]!.cheapest).toBe(false);
  });

  test("rules suffixes become a short tag", () => {
    const tagged = cards.filter((c) => c.rules !== null);
    for (const c of tagged) expect(c.rules).toMatch(/^rules [0-9a-f]+$/);
    expect(tagged.length).toBe(review.setups.filter((s) => /\(rules [0-9a-f]+\)/.test(s.label)).length);
  });
});

describe("formatGenerated", () => {
  test("reads as a UTC date and time", () => {
    expect(formatGenerated("2026-10-12T01:59:31.458Z")).toBe("12 Oct 2026, 01:59 UTC");
  });
  test("an unparseable value is shown as given", () => {
    expect(formatGenerated("not a date")).toBe("not a date");
  });
});
