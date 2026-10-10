import { describe, expect, test } from "bun:test";
import { summariseTrace, type SpanNode } from "../../../src/obs/summary.ts";

function tool(name: string, over: Partial<SpanNode> = {}): SpanNode {
  return {
    name,
    kind: "TOOL",
    status: "ok",
    attributes: {},
    durationMs: 10,
    children: [],
    ...over,
  };
}

function trace(children: SpanNode[] = []): SpanNode {
  return {
    name: "trace",
    kind: "TRACE",
    status: "ok",
    attributes: {},
    durationMs: 0,
    children,
  };
}

describe("summariseTrace", () => {
  test("counts TOOL spans recursively", () => {
    const root = trace([
      tool("tool-1", { durationMs: 10 }),
      {
        name: "wrapper",
        kind: "STEP",
        status: "ok",
        attributes: {},
        durationMs: 20,
        children: [
          tool("tool-2", { durationMs: 5 }),
          tool("tool-3", { durationMs: 5 }),
        ],
      },
      { name: "llm", kind: "LLM", status: "ok", attributes: {}, durationMs: 30, children: [] },
    ]);

    expect(summariseTrace(root).toolCalls).toBe(3);
  });

  test("lists names and messages from error spans", () => {
    const root = trace([
      tool("install", { status: "error", attributes: { "error.message": "failed install" } }),
      tool("test", { status: "error", attributes: { "error.message": "tests failed" } }),
      tool("fine", { status: "ok" }),
    ]);

    const result = summariseTrace(root);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].name).toBe("install");
    expect(result.errors[0].message).toBe("failed install");
    expect(result.errors[1].name).toBe("test");
    expect(result.errors[1].message).toBe("tests failed");
  });

  test("omits error message when attribute missing", () => {
    const root = trace([tool("install", { status: "error" })]);

    const result = summariseTrace(root);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].name).toBe("install");
    expect(result.errors[0].message).toBeUndefined();
  });

  test("counts retries only above attempt 1", () => {
    const root = trace([
      tool("attempt-1", { attributes: { "roster.attempt": 1 } }),
      {
        name: "wrapper",
        kind: "STEP",
        status: "ok",
        attributes: {},
        durationMs: 5,
        children: [tool("attempt-2", { attributes: { "roster.attempt": 2 } })],
      },
      tool("attempt-3", { attributes: { "roster.attempt": 3 } }),
    ]);

    expect(summariseTrace(root).retries).toBe(2);
  });

  test("sums roster.cost_usd numbers or returns null if none", () => {
    const noCost = trace([tool("a"), tool("b")]);
    expect(summariseTrace(noCost).costUsd).toBeNull();

    const withCost = trace([
      tool("a", { attributes: { "roster.cost_usd": 1.25 } }),
      {
        name: "wrapper",
        kind: "STEP",
        status: "ok",
        attributes: {},
        durationMs: 20,
        children: [tool("b", { attributes: { "roster.cost_usd": 0.75 } })],
      },
    ]);

    expect(summariseTrace(withCost).costUsd).toBe(2);
  });

  test("finds the longest TOOL span", () => {
    const root = trace([
      tool("fast", { durationMs: 10 }),
      {
        name: "step",
        kind: "STEP",
        status: "ok",
        attributes: {},
        durationMs: 1000,
        children: [tool("nested", { durationMs: 15 })],
      },
      tool("slow", { durationMs: 50 }),
    ]);

    expect(summariseTrace(root).slowest).toEqual({ name: "slow", durationMs: 50 });
  });

  test("returns null slowest when no TOOL spans exist", () => {
    const root = trace([
      { name: "llm", kind: "LLM", status: "ok", attributes: {}, durationMs: 30, children: [] },
    ]);

    expect(summariseTrace(root).slowest).toBeNull();
  });

  test("formats oneLine like the example", () => {
    const children: SpanNode[] = [
      tool("install", {
        status: "error",
        attributes: {
          "error.message": "failed install",
          "roster.attempt": 2,
          "roster.cost_usd": 0.21,
        },
        durationMs: 500,
      }),
      tool("test", {
        status: "error",
        attributes: { "error.message": "tests failed" },
        durationMs: 90,
      }),
      ...Array.from({ length: 12 }, (_, i) =>
        tool(`tool-${i + 3}`, { durationMs: 10 + i }),
      ),
    ];

    const root = trace(children);
    const result = summariseTrace(root);

    expect(result.toolCalls).toBe(14);
    expect(result.errors.map((e) => e.name)).toEqual(["install", "test"]);
    expect(result.retries).toBe(1);
    expect(result.costUsd).toBe(0.21);
    expect(result.slowest).toEqual({ name: "install", durationMs: 500 });
    expect(result.oneLine).toBe("14 tool calls, 2 errors (install, test), 1 retry, $0.21");
  });
});
