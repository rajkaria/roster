// F37: the coordinator's prompt and tool descriptions are data in src/agent/prompts.ts. These tests hold that file
// to the design contract and to the tools the coordinator actually registers, so the two cannot drift apart.
import { describe, expect, test } from "bun:test";
import { SYSTEM_PROMPT as COORDINATOR_PROMPT } from "../src/agent/coordinator.ts";
import { checkPrompt, SYSTEM_PROMPT, TOOL_DOCS } from "../src/agent/prompts.ts";
import { TOOL_SPECS } from "../src/agent/tools.ts";

describe("SYSTEM_PROMPT", () => {
  test("carries the coordinator/gate split", () => {
    expect(SYSTEM_PROMPT).toContain("You decide what to try next. The gate decides what ships.");
  });

  test("carries the tool-result honesty rule", () => {
    expect(SYSTEM_PROMPT).toContain("Never claim a result the tools didn't return.");
  });

  test("states the budget is a hard stop", () => {
    expect(SYSTEM_PROMPT).toMatch(/budget[^.]*stop|stop[^.]*budget/i);
  });

  test("is the prompt the coordinator ships", () => {
    expect(SYSTEM_PROMPT).toBe(COORDINATOR_PROMPT);
  });
});

describe("TOOL_DOCS", () => {
  const registered = TOOL_SPECS.map((t) => t.name);

  test("documents exactly the registered tools", () => {
    expect(Object.keys(TOOL_DOCS).sort()).toEqual([...registered].sort());
  });

  test("gives every tool a non-empty description", () => {
    for (const [name, doc] of Object.entries(TOOL_DOCS)) {
      expect(typeof name).toBe("string");
      expect(doc.trim().length).toBeGreaterThan(0);
    }
  });

  test("describes each registered tool with that tool's own description", () => {
    for (const spec of TOOL_SPECS) {
      expect(TOOL_DOCS[spec.name]).toBe(spec.description);
    }
  });
});

describe("checkPrompt", () => {
  const docsKeys = Object.keys(TOOL_DOCS);

  test("ok when the registered set matches", () => {
    expect(checkPrompt([...docsKeys])).toEqual({ ok: true, missing: [], extra: [] });
    expect(checkPrompt(TOOL_SPECS.map((t) => t.name)).ok).toBe(true);
  });

  test("missing when a documented tool is not registered", () => {
    const result = checkPrompt([]);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([...docsKeys].sort());
    expect(result.extra).toEqual([]);
  });

  test("extra when a registered tool has no doc", () => {
    const result = checkPrompt([...docsKeys, "tool_not_in_docs"]);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual(["tool_not_in_docs"]);
  });

  test("reports both sides at once and ignores duplicates and order", () => {
    const result = checkPrompt(["a_tool", "b_tool", "a_tool"]);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([...docsKeys].sort());
    expect(result.extra).toEqual(["a_tool", "b_tool"]);
  });

  test("does not mutate the registered list", () => {
    const registered = [...docsKeys, "z_extra"];
    checkPrompt(registered);
    expect(registered).toEqual([...docsKeys, "z_extra"]);
  });
});
