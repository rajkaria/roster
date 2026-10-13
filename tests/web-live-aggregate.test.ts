// The /r cross-repo model table (post-deadline): grouping, weighting and the priced-only cost.
import { expect, test } from "bun:test";
import { byModel, modelKey } from "../web/lib/live-aggregate.ts";

const s = (model: string | null, sessions: number, mature: number, spend: number | null, survival: number | null, surviving: number | null = null) => ({
  model, sessions, mature_sessions: mature, spend_usd: spend, survival, surviving_changes: surviving,
});

test("model keys drop provider prefixes and Bedrock version suffixes", () => {
  expect([modelKey("anthropic.claude-sonnet-5-5"), modelKey("us.anthropic.claude-opus-4-6-v1:0"), modelKey("openai.gpt-5.6-luna")]).toEqual(["claude-sonnet-5-5", "claude-opus-4-6", "gpt-5.6-luna"]);
});

test("model keys drop the context-window suffix", () => {
  expect([modelKey("claude-opus-4-6[1m]"), modelKey("claude-opus-4-6"), modelKey(null), modelKey("")]).toEqual(["claude-opus-4-6", "claude-opus-4-6", "unknown", "unknown"]);
});

test("setups group by model across repos, survival weighted by mature sessions, cost over surviving changes", () => {
  const rows = byModel([
    { repo: "a/one", setups: [s("opus", 10, 8, 4, 0.5, 4), s("opus[1m]", 2, 2, null, 1)] },
    { repo: "b/two", setups: [s("opus", 5, 0, 2, null, 0), s("gpt", 1, 1, 3, 0, 0)] },
  ]);
  expect(rows).toEqual([
    { model: "opus", repos: 2, sessions: 17, mature_sessions: 10, survival: (0.5 * 8 + 1 * 2) / 10, priced_spend: 6, cost_per_surviving_change: 1 },
    { model: "gpt", repos: 1, sessions: 1, mature_sessions: 1, survival: 0, priced_spend: 3, cost_per_surviving_change: null },
  ]);
});

test("no priced setups means no spend, never $0", () => {
  expect(byModel([{ repo: "a/b", setups: [s("x", 1, 0, null, null)] }])[0]).toMatchObject({ priced_spend: null, cost_per_surviving_change: null, survival: null });
});
