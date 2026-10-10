import { describe, expect, test } from "bun:test";
import { turnCap } from "../src/replay/run.ts";
import { countAssistantTurns } from "../src/replay/tasks.ts";

describe("turnCap", () => {
  test("scales with the original session: 59 turns -> 118", () => {
    expect(turnCap({ originalTurns: 59 })).toBe(118);
  });
  test("rounds up and never goes below 60", () => {
    expect(turnCap({ originalTurns: 10 })).toBe(60);
    expect(turnCap({ originalTurns: 30 })).toBe(60);
    expect(turnCap({ originalTurns: 31 })).toBe(62);
  });
  test("unknown original turns -> 80", () => {
    expect(turnCap({ originalTurns: null })).toBe(80);
  });
  test("an explicit maxTurns wins", () => {
    expect(turnCap({ originalTurns: 59 }, 5)).toBe(5);
    expect(turnCap({ originalTurns: null }, 200)).toBe(200);
  });
});

describe("countAssistantTurns", () => {
  const row = (o: object) => JSON.stringify(o);
  test("counts distinct assistant messages, not rows", () => {
    const text = [
      row({ type: "user", message: { content: "hi" } }),
      row({ type: "assistant", message: { id: "m1", content: [] } }),
      row({ type: "assistant", message: { id: "m1", content: [] } }),
      row({ type: "assistant", message: { id: "m2", content: [] } }),
      "{torn",
    ].join("\n");
    expect(countAssistantTurns(text)).toBe(2);
  });
  test("null when there is no transcript or no assistant row", () => {
    expect(countAssistantTurns(null)).toBeNull();
    expect(countAssistantTurns(row({ type: "user" }))).toBeNull();
  });
});
