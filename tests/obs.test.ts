import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { FailureCode } from "../src/types.ts";
import { ATTR, toAttributes } from "../src/obs/attributes.ts";
import { flushObs, initObs, obsEnabled, recordAttempt, setSession, withSpan } from "../src/obs/index.ts";

// The SDK is mocked at the module boundary. Each trace() call becomes a node in `roots`, nested under the open span.
interface Rec {
  kind: string;
  name: string;
  attrs: Record<string, string | number | boolean>;
  children: Rec[];
}

const roots: Rec[] = [];
const open: Rec[] = [];
const sdkCalls = { init: [] as unknown[], flush: 0 };

mock.module("neatlogs", () => ({
  init: async (opts: unknown) => {
    sdkCalls.init.push(opts);
    return true;
  },
  trace: async <T>(opts: { name: string; kind: string }, fn: (span: unknown) => Promise<T>): Promise<T> => {
    const rec: Rec = { kind: opts.kind, name: opts.name, attrs: {}, children: [] };
    (open.at(-1)?.children ?? roots).push(rec);
    open.push(rec);
    try {
      return await fn({
        setAttribute: (k: string, v: string | number | boolean) => {
          rec.attrs[k] = v;
        },
        traceId: "trace-abc",
      });
    } finally {
      open.pop();
    }
  },
  flush: async () => {
    sdkCalls.flush += 1;
  },
}));

const SAVED_KEY = process.env.NEATLOGS_API_KEY;
let warnings: string[] = [];
const realWarn = console.warn;

beforeAll(() => {
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
});

afterAll(() => {
  console.warn = realWarn;
  if (SAVED_KEY === undefined) delete process.env.NEATLOGS_API_KEY;
  else process.env.NEATLOGS_API_KEY = SAVED_KEY;
});

describe("attributes", () => {
  test("maps fields to the exact roster.* names and drops unset ones", () => {
    expect(
      toAttributes({
        setup: "A",
        task: "t1",
        attempt: 2,
        failureCode: FailureCode.F3,
        evidenceLevel: "B",
        repo: "org/repo",
        costUsd: 0.42,
      }),
    ).toEqual({
      "roster.setup": "A",
      "roster.task": "t1",
      "roster.attempt": 2,
      "roster.failure_code": "F3",
      "roster.evidence_level": "B",
      "roster.repo": "org/repo",
      "roster.cost_usd": 0.42,
    });
    expect(toAttributes({ setup: "B" })).toEqual({ "roster.setup": "B" });
  });

  test("joins multiple failure codes into one attribute", () => {
    expect(toAttributes({ failureCode: [FailureCode.F1, FailureCode.F7] })[ATTR.failureCode]).toBe("F1,F7");
  });
});

describe("without NEATLOGS_API_KEY", () => {
  test("initObs is a no-op that resolves false and warns exactly once", async () => {
    delete process.env.NEATLOGS_API_KEY;
    expect(await initObs({ workflowName: "review" })).toBe(false);
    expect(await initObs({ workflowName: "review" })).toBe(false);
    expect(obsEnabled()).toBe(false);
    expect(warnings.filter((w) => w.includes("NEATLOGS_API_KEY"))).toHaveLength(1);
    expect(sdkCalls.init).toHaveLength(0);
  });

  test("withSpan still runs the body and returns its value; flush and recordAttempt do nothing", async () => {
    const value = await withSpan("WORKFLOW", "review", { repo: "org/repo" }, async (span) => {
      span.setAttribute("ignored", 1);
      return 42;
    });
    expect(value).toBe(42);
    await recordAttempt({ setup: "A" }, 1, { failureCode: FailureCode.F1 });
    await flushObs();
    expect(roots).toHaveLength(0);
    expect(sdkCalls.flush).toBe(0);
  });
});

describe("with NEATLOGS_API_KEY", () => {
  beforeAll(() => {
    process.env.NEATLOGS_API_KEY = "test-key";
  });

  test("initObs passes the key and workflow name to the SDK", async () => {
    expect(await initObs({ workflowName: "roster-review" })).toBe(true);
    expect(obsEnabled()).toBe(true);
    expect(sdkCalls.init).toEqual([{ apiKey: "test-key", workflowName: "roster-review" }]);
  });

  test("one review is one trace: WORKFLOW → AGENT → TOOL and GUARDRAIL, with roster.* attributes", async () => {
    setSession("review-42");
    await withSpan("WORKFLOW", "review", { repo: "org/repo" }, async () => {
      await withSpan("AGENT", "coordinator", { setup: "A" }, async () => {
        await withSpan("TOOL", "ingest", { repo: "org/repo" }, async () => undefined);
        await withSpan("TOOL", "score", {}, async () => undefined);
        await recordAttempt(
          { setup: "A", task: "t1" },
          1,
          { failureCode: FailureCode.F3, evidenceLevel: "B", costUsd: 0.5 },
        );
        await withSpan("GUARDRAIL", "gate", { setup: "B", evidenceLevel: "B" }, async () => undefined);
      });
    });

    expect(roots).toHaveLength(1);
    const workflow = roots[0]!;
    expect(workflow).toMatchObject({
      kind: "WORKFLOW",
      name: "review",
      attrs: { "roster.repo": "org/repo", "session.id": "review-42" },
    });
    expect(workflow.children).toHaveLength(1);

    const agent = workflow.children[0]!;
    expect(agent).toMatchObject({ kind: "AGENT", name: "coordinator", attrs: { "roster.setup": "A" } });
    expect(agent.children.map((c) => [c.kind, c.name])).toEqual([
      ["TOOL", "ingest"],
      ["TOOL", "score"],
      ["TOOL", "replay attempt 1"],
      ["GUARDRAIL", "gate"],
    ]);

    const attempt = agent.children[2]!;
    expect(attempt.attrs).toEqual({
      "roster.setup": "A",
      "roster.task": "t1",
      "roster.attempt": 1,
      "roster.failure_code": "F3",
      "roster.evidence_level": "B",
      "roster.cost_usd": 0.5,
      "session.id": "review-42",
    });

    const gate = agent.children[3]!;
    expect(gate.attrs).toMatchObject({ "roster.setup": "B", "roster.evidence_level": "B" });
  });

  test("an error inside a span still closes the span and reaches the caller", async () => {
    const before = roots.length;
    await expect(
      withSpan("WORKFLOW", "failing", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(roots).toHaveLength(before + 1);
    expect(open).toHaveLength(0);
  });

  test("the span body receives the trace id when the SDK exposes it", async () => {
    const id = await withSpan("WORKFLOW", "probe", {}, async (span) => span.traceId);
    expect(id).toBe("trace-abc");
  });

  test("flushObs awaits the SDK flush", async () => {
    const before = sdkCalls.flush;
    await flushObs();
    expect(sdkCalls.flush).toBe(before + 1);
  });
});
