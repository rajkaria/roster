import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { toAttributes, capAttr, MAX_STRING_BYTES, MAX_ARRAY_ITEMS } from "../src/obs/attributes.ts";
import { _resetObsForTests, _useSdkForTests, flushObs, initObs, obsEnabled, withSpan } from "../src/obs/index.ts";

// The SDK is mocked at the module boundary.
const sdk = {
  init: [] as unknown[],
  flushAll: 0,
  flushResults: [] as Array<boolean | Error>,
  attrs: [] as Array<Record<string, unknown>>,
};

// mock.module is process-wide and other test files mock "neatlogs" too, so this mock is installed when this
// file's tests start (initObs imports the SDK lazily) and the previous one is put back afterwards.
const fakeSdk = () => ({
  init: async (opts: unknown) => {
    sdk.init.push(opts);
  },
  trace: async <T>(_o: unknown, fn: (span: unknown) => Promise<T>): Promise<T> => {
    const rec: Record<string, unknown> = {};
    sdk.attrs.push(rec);
    return fn({ setAttribute: (k: string, v: unknown) => void (rec[k] = v) });
  },
  flushAll: async () => {
    sdk.flushAll += 1;
    const r = sdk.flushResults.shift() ?? true;
    if (r instanceof Error) throw r;
    return r;
  },
  flush: async () => true,
});

const SAVED_KEY = process.env.NEATLOGS_API_KEY;
const realWarn = console.warn;
let warnings: string[] = [];
let previousSdk: Record<string, unknown> = {};

beforeAll(async () => {
  previousSdk = { ...(await import("neatlogs")) } as Record<string, unknown>;
  mock.module("neatlogs", fakeSdk);
  process.env.NEATLOGS_API_KEY = "test-key";
  console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(" "));
});
afterAll(() => {
  mock.module("neatlogs", () => previousSdk);
  console.warn = realWarn;
  if (SAVED_KEY === undefined) delete process.env.NEATLOGS_API_KEY;
  else process.env.NEATLOGS_API_KEY = SAVED_KEY;
  _resetObsForTests();
});
beforeEach(() => {
  _resetObsForTests();
  sdk.init = [];
  sdk.flushAll = 0;
  sdk.flushResults = [];
  sdk.attrs = [];
  warnings = [];
});

describe("initObs is idempotent", () => {
  test("two calls with different workflow names start the SDK once", async () => {
    expect(await initObs({ workflowName: "roster-review" })).toBe(true);
    expect(await initObs({ workflowName: "roster-run" })).toBe(true);
    expect(sdk.init).toHaveLength(1);
    expect(obsEnabled()).toBe(true);
  });

  test("concurrent calls also start the SDK once", async () => {
    await Promise.all([initObs({ workflowName: "a" }), initObs({ workflowName: "b" })]);
    expect(sdk.init).toHaveLength(1);
  });
});

describe("attribute caps", () => {
  test("an oversized string is truncated to the cap", () => {
    const out = capAttr("x".repeat(10_000)) as string;
    expect(out.length).toBeLessThanOrEqual(MAX_STRING_BYTES);
    expect(out.startsWith("xxx")).toBe(true);
  });

  test("arrays are cut to 50 items and objects become counts", () => {
    const arr = capAttr(Array.from({ length: 200 }, (_, i) => `s${i}`)) as string;
    expect(arr.split(",")).toHaveLength(MAX_ARRAY_ITEMS);
    expect(capAttr({ a: 1, b: 2, c: [1] })).toBe("{3 keys}");
  });

  test("toAttributes caps strings, and withSpan writes the capped value", async () => {
    expect((toAttributes({ repo: "r".repeat(5000) })["roster.repo"] as string).length).toBeLessThanOrEqual(MAX_STRING_BYTES);
    await initObs({ workflowName: "w" });
    await withSpan("TOOL", "t", {}, async (span) => span.setAttribute("transcript", "y".repeat(9000)));
    expect((sdk.attrs[0]!.transcript as string).length).toBeLessThanOrEqual(MAX_STRING_BYTES);
  });
});

describe("flushObs", () => {
  test("a failing flush retries once, warns once with span counts, and never throws", async () => {
    _useSdkForTests(fakeSdk());
    await withSpan("TOOL", "a", {}, async () => undefined);
    await withSpan("TOOL", "b", {}, async () => undefined);
    sdk.flushResults = [new Error("Request timed out"), false];
    expect(await flushObs({ timeoutMs: 1000 })).toBe(false);
    expect(sdk.flushAll).toBe(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("0 spans sent, 2 failed");
  });

  test("a retry that succeeds is silent and counts spans as sent", async () => {
    _useSdkForTests(fakeSdk());
    await withSpan("TOOL", "a", {}, async () => undefined);
    sdk.flushResults = [false, true];
    expect(await flushObs({ timeoutMs: 1000 })).toBe(true);
    expect(sdk.flushAll).toBe(2);
    expect(warnings).toHaveLength(0);
  });
});
