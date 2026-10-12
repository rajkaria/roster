import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ogCard } from "../web/lib/og.ts";

const row = (task: string, costOld: number | null, costNew: number | null, excluded?: string) => ({
  task,
  old: false,
  new: true,
  costOld,
  costNew,
  ...(excluded ? { excluded } : {}),
});

describe("ogCard", () => {
  test("the result sentence is forward.json's wording, verbatim", () => {
    const card = ogCard({ summary: { n: 2, wording: "2 vs 0 passed, p = 0.500" }, rows: [row("a", 1, 0.5), row("b", 2, 0.1)] });
    expect(card.result).toBe("2 vs 0 passed, p = 0.500");
    expect(card.pairs).toBe("2 pre-registered task pairs");
  });

  test("the cost line leaves out excluded rows and unpriced pairs", () => {
    const card = ogCard({
      summary: { n: 3, wording: "w" },
      rows: [row("a", 0.3, 0.1), row("b", 0.1, 0.2), row("c", 0.5, 0.01), row("x", 9, 0.001, "F6"), row("u", null, 0.1)],
    });
    expect(card.cost).toBe("cheaper in 2 of 3 pairs, median $0.100 vs $0.300");
  });

  test("no summary gives an empty card; no priced pairs gives no cost line", () => {
    expect(ogCard(undefined)).toEqual({ result: null, pairs: null, cost: null });
    expect(ogCard({ rows: [row("a", 1, 0.5)] })).toEqual({ result: null, pairs: null, cost: null });
    expect(ogCard({ summary: { n: 1, wording: "w" }, rows: [row("a", null, null)] }).cost).toBeNull();
  });

  test("the published forward.json gives the headline numbers", () => {
    const json = JSON.parse(readFileSync(join(import.meta.dir, "..", "reports/self/forward.json"), "utf8"));
    expect(ogCard(json)).toEqual({
      result: json.summary.wording,
      pairs: `${json.summary.n} pre-registered task pairs`,
      cost: "cheaper in 35 of 35 pairs, median $0.020 vs $0.148",
    });
  });
});
