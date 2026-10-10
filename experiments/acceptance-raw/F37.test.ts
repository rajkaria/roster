import { describe, expect, test } from "bun:test";
import {
  SYSTEM_PROMPT,
  TOOL_DOCS,
  checkPrompt,
} from "../../../src/agent/prompts.ts";

describe("F37 coordinator prompt as data", () => {
  test("SYSTEM_PROMPT contains the required coordinator/gate sentence", () => {
    expect(SYSTEM_PROMPT).toContain(
      "You decide what to try next. The gate decides what ships."
    );
  });

  test("SYSTEM_PROMPT contains the required tool-result honesty sentence", () => {
    expect(SYSTEM_PROMPT).toContain(
      "Never claim a result the tools didn't return."
    );
  });

  test("SYSTEM_PROMPT states that the budget stops the run", () => {
    expect(SYSTEM_PROMPT).toMatch(/budget[^.]*stop|stop[^.]*budget/i);
  });

  const docsKeys = Object.keys(TOOL_DOCS);

  test("checkPrompt returns ok when registered tools match TOOL_DOCS keys", () => {
    const result = checkPrompt([...docsKeys]);

    expect(result).toEqual({ ok: true, missing: [], extra: [] });
  });

  test("checkPrompt reports TOOL_DOCS keys missing from registered tools", () => {
    const result = checkPrompt([]);

    expect(result.ok).toBe(docsKeys.length === 0);
    expect(result.missing.sort()).toEqual([...docsKeys].sort());
    expect(result.extra).toEqual([]);
  });

  test("checkPrompt reports registered tools not present in TOOL_DOCS", () => {
    const extra = "tool_not_in_docs";
    const result = checkPrompt([...docsKeys, extra]);

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([extra]);
  });
});
