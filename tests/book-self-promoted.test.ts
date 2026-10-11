import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadSetups } from "../src/setups/registry";
import { bookFromReview } from "../scripts/book-self";

const root = join(import.meta.dir, "..");
const E = loadSetups(root, {}).filter((s) => s.id === "E");

const setup = (setup_id: string, harness: string, model: string, sessions: number, spend: number, surviving: number) => ({
  setup_id,
  label: `${harness} · ${model}`,
  harness,
  model,
  sessions,
  spend_usd: spend,
  unattended: 0.5,
  surviving_changes: surviving,
});
const sessions = [{ started_at: "2026-10-01T00:00:00Z", ended_at: "2026-10-11T00:00:00Z" }];
const fixture = (extra: Record<string, unknown> = {}) => ({
  id: "r",
  repo: "x/y",
  setups: [
    setup("aaa111", "Claude Code", "claude-sonnet-5-5", 10, 5, 8),
    setup("bbb222", "Claude Code", "deepseek-flash", 40, 4, 30),
  ],
  ...extra,
});

test("E resolves by model to the deepseek-flash setup and the scenario has rates", () => {
  expect(E.length).toBe(1);
  const f = bookFromReview(fixture(), sessions, { promoted: "E" }, "r.json", E);
  expect(f.promoted).toEqual({ id: "bbb222", source: "E", note: null, matchedBy: "model" });
  expect(f.scenario.scaleMonthlyUsd).not.toBeNull();
  expect(f.scenario.scaleSurvivingChangesPerMonth).not.toBeNull();
});

test("the review's tag map wins over the model match", () => {
  const review = fixture({ tags: { by_tag: { E: { sessions: 10, setup_ids: ["aaa111"] } } } });
  const f = bookFromReview(review, sessions, { promoted: "E" }, "r.json", E);
  expect(f.promoted.id).toBe("aaa111");
  expect(f.promoted.matchedBy).toBe("tag");
});

test("a harness mismatch does not match by model", () => {
  const review = fixture();
  review.setups[1] = setup("bbb222", "Codex", "deepseek-flash", 40, 4, 30);
  const f = bookFromReview(review, sessions, { promoted: "E" }, "r.json", E);
  expect(f.promoted.id).toBeNull();
  expect(f.promoted.matchedBy).toBeNull();
});

test("unmatched keeps the note and a null scenario", () => {
  const review = fixture();
  review.setups.pop();
  const f = bookFromReview(review, sessions, { promoted: "E" }, "r.json", E);
  expect(f.promoted.id).toBeNull();
  expect(f.promoted.note).toContain("has no sessions in this review");
  expect(f.scenario.scaleMonthlyUsd).toBeNull();
});

test("a review setup id promoted directly matches by id", () => {
  const f = bookFromReview(fixture(), sessions, { promoted: "aaa111" }, "r.json", E);
  expect(f.promoted).toEqual({ id: "aaa111", source: "aaa111", note: null, matchedBy: "id" });
});
