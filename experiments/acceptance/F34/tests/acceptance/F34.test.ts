import { describe, expect, test } from "bun:test";
import { collectCosts } from "../../scripts/costs.ts";

type CostRow = { source: string; setup: string; costUsd: number | null };

function replayEntry(setup: string, costUsd: number | null) {
  return { setup, setup_id: setup, setupId: setup, costUsd, cost_usd: costUsd };
}

function forwardPair(
  oldSetup: string,
  oldCost: number | null,
  newSetup: string,
  newCost: number | null,
) {
  return {
    setupOld: oldSetup,
    setupNew: newSetup,
    setup_old: oldSetup,
    setup_new: newSetup,
    costOld: oldCost,
    costNew: newCost,
    cost_old: oldCost,
    cost_new: newCost,
  };
}

function reviewSetup(setup: string, costUsd: number | null) {
  return { setup, setup_id: setup, setupId: setup, label: setup, costUsd, cost_usd: costUsd };
}

function rowsMatching(rows: CostRow[], sourcePart: string): CostRow[] {
  return rows.filter((row) => row.source.includes(sourcePart));
}

describe("collectCosts", () => {
  test("reads replay, forward and review costs and ignores unknown files", () => {
    const result = collectCosts([
      {
        path: "replays.json",
        json: {
          data: [
            replayEntry("setup-a", 1.5),
            replayEntry("setup-b", null),
            replayEntry("setup-c", 2.5),
          ],
        },
      },
      {
        path: "forward.json",
        json: {
          data: {
            pairs: [
              forwardPair("setup-old", 3.5, "setup-new", 4.5),
              forwardPair("setup-old2", null, "setup-new2", 6.5),
            ],
          },
        },
      },
      {
        path: "review.json",
        json: {
          data: {
            setups: [
              reviewSetup("setup-review", 7.5),
              reviewSetup("setup-review2", null),
            ],
          },
        },
      },
      {
        path: "unknown.json",
        json: { data: [{ setup: "x", costUsd: 99 }] },
      },
    ]);

    expect(result.replayRuns).toBe(3);
    expect(result.forwardRuns).toBe(4);
    expect(result.reviewRuns).toBe(2);
    expect(result.rows).toHaveLength(9);

    const replayRows = rowsMatching(result.rows, "replay");
    const forwardRows = rowsMatching(result.rows, "forward");
    const reviewRows = rowsMatching(result.rows, "review");

    expect(replayRows).toHaveLength(3);
    expect(forwardRows).toHaveLength(4);
    expect(reviewRows).toHaveLength(2);

    expect(replayRows.find((row) => row.setup === "setup-a")?.costUsd).toBe(1.5);
    expect(replayRows.find((row) => row.setup === "setup-b")?.costUsd).toBeNull();
    expect(replayRows.find((row) => row.setup === "setup-c")?.costUsd).toBe(2.5);

    expect(forwardRows.find((row) => row.setup === "setup-old")?.costUsd).toBe(3.5);
    expect(forwardRows.find((row) => row.setup === "setup-new")?.costUsd).toBe(4.5);
    expect(forwardRows.find((row) => row.setup === "setup-old2")?.costUsd).toBeNull();
    expect(forwardRows.find((row) => row.setup === "setup-new2")?.costUsd).toBe(6.5);

    expect(reviewRows.find((row) => row.setup === "setup-review")?.costUsd).toBe(7.5);
    expect(reviewRows.find((row) => row.setup === "setup-review2")?.costUsd).toBeNull();
  });

  test("skips malformed entries and does not count them", () => {
    const result = collectCosts([
      {
        path: "replays.json",
        json: {
          data: [
            replayEntry("valid-replay", 1),
            { setup: "missing-cost", setup_id: "missing-cost", setupId: "missing-cost" },
            { costUsd: 2, cost_usd: 2 },
            { setup: "bad-cost", setup_id: "bad-cost", setupId: "bad-cost", costUsd: "bad", cost_usd: "bad" },
          ],
        },
      },
      {
        path: "forward.json",
        json: {
          data: {
            pairs: [
              forwardPair("valid-old", 10, "valid-new", 20),
              {
                setupOld: "missing-costs-old",
                setupNew: "missing-costs-new",
                setup_old: "missing-costs-old",
                setup_new: "missing-costs-new",
              },
              {
                setupOld: "bad-costs-old",
                setupNew: "bad-costs-new",
                setup_old: "bad-costs-old",
                setup_new: "bad-costs-new",
                costOld: "bad",
                costNew: "bad",
                cost_old: "bad",
                cost_new: "bad",
              },
            ],
          },
        },
      },
      {
        path: "review.json",
        json: {
          data: {
            setups: [
              reviewSetup("valid-review", 30),
              { setup: "missing-cost-review", setup_id: "missing-cost-review", setupId: "missing-cost-review", label: "missing-cost-review" },
              { costUsd: 40, cost_usd: 40 },
              { setup: "bad-cost-review", setup_id: "bad-cost-review", setupId: "bad-cost-review", label: "bad-cost-review", costUsd: "bad", cost_usd: "bad" },
            ],
          },
        },
      },
    ]);

    expect(result.replayRuns).toBe(1);
    expect(result.forwardRuns).toBe(2);
    expect(result.reviewRuns).toBe(1);
    expect(result.rows).toHaveLength(4);

    const replayRows = rowsMatching(result.rows, "replay");
    const forwardRows = rowsMatching(result.rows, "forward");
    const reviewRows = rowsMatching(result.rows, "review");

    expect(replayRows).toHaveLength(1);
    expect(forwardRows).toHaveLength(2);
    expect(reviewRows).toHaveLength(1);

    expect(replayRows[0]).toMatchObject({ setup: "valid-replay", costUsd: 1 });
    expect(forwardRows.find((row) => row.setup === "valid-old")?.costUsd).toBe(10);
    expect(forwardRows.find((row) => row.setup === "valid-new")?.costUsd).toBe(20);
    expect(reviewRows[0]).toMatchObject({ setup: "valid-review", costUsd: 30 });
  });
});
