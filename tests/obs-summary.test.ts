import { describe, expect, test } from "bun:test";
import { summariseTrace, type SpanNode } from "../src/obs/summary.ts";

const span = (name: string, kind: string, o: Partial<SpanNode> = {}): SpanNode => ({
  name,
  kind,
  status: "ok",
  attributes: {},
  durationMs: 1,
  children: [],
  ...o,
});

describe("summariseTrace", () => {
  test("trace with no tool spans", () => {
    const s = summariseTrace(span("review", "WORKFLOW"));
    expect(s).toEqual({ toolCalls: 0, errors: [], retries: 0, costUsd: null, slowest: null, oneLine: "0 tool calls" });
  });

  test("full trace", () => {
    const root = span("review", "WORKFLOW", {
      children: [
        span("coordinator", "AGENT", {
          children: [
            span("ingest", "TOOL", { durationMs: 10, attributes: { "roster.cost_usd": 0.1 } }),
            span("install", "TOOL", {
              status: "error",
              durationMs: 90,
              attributes: { "error.message": "boom", "roster.attempt": 2 },
            }),
            span("test", "TOOL", {
              status: "error",
              durationMs: 40,
              attributes: { "roster.cost_usd": 0.11, "roster.attempt": 1 },
            }),
          ],
        }),
      ],
    });
    const s = summariseTrace(root);
    expect(s.toolCalls).toBe(3);
    expect(s.errors).toEqual([{ name: "install", message: "boom" }, { name: "test" }]);
    expect(s.retries).toBe(1);
    expect(s.costUsd).toBeCloseTo(0.21);
    expect(s.slowest).toEqual({ name: "install", durationMs: 90 });
    expect(s.oneLine).toBe("3 tool calls, 2 errors (install, test), 1 retry, $0.21");
  });

  test("plurals, and non-numeric attributes are ignored", () => {
    const root = span("r", "WORKFLOW", {
      children: [
        span("a", "TOOL", { attributes: { "roster.attempt": 3, "roster.cost_usd": "x" } }),
        span("b", "TOOL", { attributes: { "roster.attempt": 2 } }),
      ],
    });
    const s = summariseTrace(root);
    expect(s.costUsd).toBeNull();
    expect(s.oneLine).toBe("2 tool calls, 2 retries");
    expect(summariseTrace(span("t", "TOOL")).oneLine).toBe("1 tool call");
  });
});
