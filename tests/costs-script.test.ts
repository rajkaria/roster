import { expect, test } from "bun:test";
import { collectCosts } from "../scripts/costs";

test("collects replay, forward and review costs and counts each kind", () => {
  const out = collectCosts([
    { path: "r/replays.json", json: { data: [{ setup: "a", costUsd: 1.5 }, { setup: "b", costUsd: null }] } },
    {
      path: "r/forward.json",
      json: { data: { pairs: [{ setupOld: "o", setupNew: "n", costOld: 2, costNew: 3 }] } },
    },
    { path: "r/review.json", json: { data: { setups: [{ setup: "a", costUsd: 4 }] } } },
  ]);
  expect(out.replayRuns).toBe(2);
  expect(out.forwardRuns).toBe(2);
  expect(out.reviewRuns).toBe(1);
  expect(out.rows).toContainEqual({ source: "r/forward.json", setup: "n", costUsd: 3 });
  expect(out.rows).toContainEqual({ source: "r/replays.json", setup: "b", costUsd: null });
});

test("ignores unknown files and skips malformed entries without counting them", () => {
  const out = collectCosts([
    { path: "x/other.json", json: { data: [{ setup: "a", costUsd: 1 }] } },
    {
      path: "x/replays.json",
      json: { data: [null, 5, { setup: "a", costUsd: "1" }, { costUsd: 1 }, { setup: "ok", costUsd: 0 }] },
    },
    { path: "x/forward.json", json: { data: { pairs: [{ setupOld: "o", costOld: 1, costNew: 2 }] } } },
    { path: "x/review.json", json: "garbage" },
  ]);
  expect(out.replayRuns).toBe(1);
  expect(out.forwardRuns).toBe(1);
  expect(out.reviewRuns).toBe(0);
  expect(out.rows).toHaveLength(2);
});
