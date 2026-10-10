// Checks the real neatlogs package (pinned in package.json) against the calls src/obs makes. No network:
// init is never called here, and nothing is flushed to the ingest endpoint.
import { describe, expect, test } from "bun:test";
import * as neatlogs from "neatlogs";
import type { InitOptions, TraceOptions } from "neatlogs";
import { wrapOpenAI } from "neatlogs/openai";
import OpenAI from "openai";

describe("neatlogs exports used by src/obs", () => {
  test("init, trace and flush are functions with the arity src/obs relies on", () => {
    expect(typeof neatlogs.init).toBe("function");
    expect(typeof neatlogs.trace).toBe("function");
    expect(typeof neatlogs.flush).toBe("function");
    // trace(options, body): two parameters, as withSpan calls it.
    expect(neatlogs.trace.length).toBe(2);
  });

  test("the init and trace option names src/obs passes exist in the SDK's types", () => {
    // Compile-time check: these literals fail `bun run typecheck` if the SDK renames an option.
    const init: InitOptions = { apiKey: "test-key", workflowName: "roster-review" };
    const root: TraceOptions = { name: "review", kind: "WORKFLOW", sessionId: "review-1" };
    const leaf: TraceOptions = { name: "ingest", kind: "TOOL" };
    expect([init.workflowName, root.kind, leaf.kind]).toEqual(["roster-review", "WORKFLOW", "TOOL"]);
  });

  test("trace runs its body and returns the body's value, with no init", async () => {
    const value = await neatlogs.trace({ name: "probe", kind: "TOOL" }, async (span) => {
      expect(typeof span.setAttribute).toBe("function");
      return 7;
    });
    expect(value).toBe(7);
  });

  test("trace exposes an OpenTelemetry span context with a trace id, which src/obs reads", async () => {
    await neatlogs.trace({ name: "probe", kind: "WORKFLOW" }, async (span) => {
      expect(typeof span.spanContext).toBe("function");
      expect(typeof span.spanContext().traceId).toBe("string");
    });
  });
});

describe("neatlogs OpenAI wrapper", () => {
  test("wrapOpenAI returns a client whose chat.completions.create is still a function", () => {
    const client = new OpenAI({ apiKey: "test-key", baseURL: "http://127.0.0.1:9", maxRetries: 0 });
    const wrapped = wrapOpenAI(client);
    expect(typeof wrapped.chat.completions.create).toBe("function");
  });
});
