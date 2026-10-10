// T56: a review's trace stays small, the flush gets 60 s and reports the SDK's outcome, and the trace id is printed.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview } from "../src/cli/review.ts";
import { ATTR, summaryAttr } from "../src/obs/attributes.ts";
import { _resetObsForTests, _useSdkForTests, flushObs, withSpan } from "../src/obs/index.ts";
import { makeFixture } from "./fixtures/make-fixture.ts";

setDefaultTimeout(120_000);

// The SDK is mocked: _useSdkForTests hands obs this stand-in, so no module mock leaks into other test files.
interface Rec {
  kind: string;
  name: string;
  attrs: Record<string, unknown>;
}
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
let spans: Rec[] = [];
let flushArgs: unknown[][] = [];
let flushResult: unknown = { success: true, outcomes: [{ pipeline: "module", success: true, timedOut: false }] };
let drops = 0;

const fakeSdk = () => ({
  trace: async <T>(o: { name: string; kind: string }, fn: (span: unknown) => Promise<T>): Promise<T> => {
    const rec: Rec = { kind: o.kind, name: o.name, attrs: {} };
    spans.push(rec);
    return fn({
      setAttribute: (k: string, v: unknown) => void (rec.attrs[k] = v),
      spanContext: () => ({ traceId: TRACE_ID }),
    });
  },
  flushAllDetailed: async (...args: unknown[]) => {
    flushArgs.push(args);
    return flushResult;
  },
  flushAll: async () => {
    throw new Error("flushAll must not be used when flushAllDetailed exists");
  },
  flush: async () => true,
  getDeliveryDiagnostics: () => ({ spanQueueDrops: drops, spanExportFailures: 0, maskedSpanDrops: 0 }),
});

const root = mkdtempSync(join(tmpdir(), "roster-obs-flush-"));
const realLog = console.log;
const realWarn = console.warn;
let printed: string[] = [];

beforeAll(() => {
  console.log = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
});
afterAll(() => {
  console.log = realLog;
  console.warn = realWarn;
  _resetObsForTests();
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  _resetObsForTests();
  _useSdkForTests(fakeSdk());
  spans = [];
  flushArgs = [];
  flushResult = { success: true, outcomes: [{ pipeline: "module", success: true, timedOut: false }] };
  drops = 0;
  printed = [];
});

describe("roster review on the T01 fixture, SDK mocked", () => {
  test("creates at most 20 spans, flushes with 60 s, prints the trace id", async () => {
    const repo = join(root, "basic");
    makeFixture(repo, "basic");
    const code = await runReview({ repo, out: join(root, "reports"), cache: join(root, "cache") });
    expect(code).toBe(0);

    expect(spans.length).toBeGreaterThan(0);
    expect(spans.length).toBeLessThanOrEqual(20);
    expect(spans.map((s) => `${s.kind} ${s.name}`)).toEqual([
      "WORKFLOW review",
      "TOOL fetch",
      "TOOL parse",
      "TOOL identify",
      "TOOL score",
    ]);

    // Session detail is one count line on the root, not a span per session.
    const summary = String(spans[0]!.attrs[ATTR.summary]);
    expect(summary).toMatch(/^sessions=\d+ mature=\d+ too_young=\d+ failed=\d+ setups=\d+ unpriced=\d+$/);
    expect(Number(summary.match(/sessions=(\d+)/)![1])).toBeGreaterThan(0);

    expect(flushArgs).toEqual([[60_000]]);
    expect(printed).toContain(`[roster] neatlogs: ${spans.length} spans exported, 0 dropped`);
    expect(printed.at(-1)).toBe(`[roster] neatlogs trace ${TRACE_ID}`);
  });
});

describe("flushObs", () => {
  test("reports the spans the SDK dropped during the flush", async () => {
    await withSpan("WORKFLOW", "review", {}, async () => {
      await withSpan("TOOL", "a", {}, async () => undefined);
      await withSpan("TOOL", "b", {}, async () => undefined);
    });
    const sdk = fakeSdk();
    _useSdkForTests({
      ...sdk,
      flushAllDetailed: async (ms: number) => {
        drops = 1;
        return sdk.flushAllDetailed(ms);
      },
    });
    expect(await flushObs()).toBe(true);
    expect(printed).toEqual([`[roster] neatlogs: 2 spans exported, 1 dropped`, `[roster] neatlogs trace ${TRACE_ID}`]);
  });

  test("a detailed result that failed is a failed attempt, and names the pipeline", async () => {
    await withSpan("WORKFLOW", "review", {}, async () => undefined);
    flushResult = { success: false, outcomes: [{ pipeline: "module", success: false, timedOut: true }] };
    expect(await flushObs()).toBe(false);
    expect(flushArgs).toEqual([[60_000], [60_000]]);
    expect(printed.some((l) => l.includes("module: timed out") && l.includes("0 spans sent, 1 failed"))).toBe(true);
    expect(printed).toContain("[roster] neatlogs: 0 spans exported, 0 dropped (flush failed)");
    // The trace id is printed even when the flush failed, so the partial trace can still be looked up.
    expect(printed.at(-1)).toBe(`[roster] neatlogs trace ${TRACE_ID}`);
  });

  test("each trace id is printed once, by the flush that follows it", async () => {
    await withSpan("WORKFLOW", "review", {}, async () => undefined);
    await withSpan("WORKFLOW", "review", {}, async () => undefined);
    await flushObs();
    await flushObs();
    expect(printed.filter((l) => l.includes("neatlogs trace"))).toEqual([`[roster] neatlogs trace ${TRACE_ID}`]);
  });

  test("summaryAttr writes counts only", () => {
    expect(summaryAttr({ sessions: 3, mature: 1 })).toBe("sessions=3 mature=1");
  });
});
