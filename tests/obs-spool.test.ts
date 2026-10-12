// T81: a flush the SDK fails or drops spans on is spooled to disk, and `roster traces flush` re-sends it.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTraces } from "../src/cli/traces.ts";
import { _resetObsForTests, _useSdkForTests, flushObs, withSpan } from "../src/obs/index.ts";
import { type OtlpTraceRequest, listSpool, traceRequestProto } from "../src/obs/spool.ts";

const KEY = "nl-test-key-7f3a9c2e";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
// The error review 1b logged when its flush timed out.
const TIMEOUT = new Error("Request timed out");

let spanSeq = 0;
let flushImpl: () => Promise<unknown> = async () => ({ success: true, outcomes: [] });
let drops = 0;

// An SDK stand-in whose spans carry OpenTelemetry-shaped ids, as the real SDK's do.
const fakeSdk = () => ({
  trace: async <T>(_o: { name: string; kind: string }, fn: (span: unknown) => Promise<T>): Promise<T> => {
    const spanId = (++spanSeq).toString(16).padStart(16, "0");
    return fn({ setAttribute() {}, spanContext: () => ({ traceId: TRACE_ID, spanId }) });
  },
  flushAllDetailed: () => flushImpl(),
  flush: async () => true,
  getDeliveryDiagnostics: () => ({ spanQueueDrops: drops, spanExportFailures: 0, maskedSpanDrops: 0 }),
});

const root = mkdtempSync(join(tmpdir(), "roster-obs-spool-"));
let dir = "";
let notes: string[] = [];
let printed: string[] = [];
const realKey = process.env.NEATLOGS_API_KEY;

async function runReviewTrace(): Promise<void> {
  await withSpan("WORKFLOW", "review", { repo: "roster" }, async () => {
    await withSpan("AGENT", "coordinator", { setup: "A" }, async () => {
      await withSpan("TOOL", "replay attempt 1", { task: "T81", attempt: 1, costUsd: 0.25 }, async () => undefined);
    });
  });
}

const flush = () =>
  flushObs({ timeoutMs: 50, retries: 0, spoolDir: dir, notify: (m) => notes.push(m), log: () => {}, print: (m) => printed.push(m) });

function allSpoolText(): string {
  return existsSync(dir) ? readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n") : "";
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
function fakeFetch(statuses: number[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: init?.body });
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)]!;
    return new Response("", { status });
  };
  return { fetch: f as unknown as typeof fetch, calls };
}

const traces = (args: string[], f: typeof fetch) =>
  runTraces([...args, "--dir", dir], {
    fetch: f,
    env: { NEATLOGS_API_KEY: KEY },
    backoffMs: 1,
    out: (m) => printed.push(m),
    err: (m) => printed.push(m),
  });

beforeEach(() => {
  _resetObsForTests();
  _useSdkForTests(fakeSdk());
  process.env.NEATLOGS_API_KEY = KEY;
  dir = mkdtempSync(join(root, "spool-"));
  rmSync(dir, { recursive: true });
  spanSeq = 0;
  drops = 0;
  flushImpl = async () => ({ success: true, outcomes: [] });
  notes = [];
  printed = [];
});
afterEach(() => {
  if (realKey === undefined) delete process.env.NEATLOGS_API_KEY;
  else process.env.NEATLOGS_API_KEY = realKey;
});
afterAll(() => {
  _resetObsForTests();
  rmSync(root, { recursive: true, force: true });
});

describe("flushObs spools what the SDK lost", () => {
  test("a flush that throws writes the trace JSON and says so", async () => {
    await runReviewTrace();
    flushImpl = async () => {
      throw TIMEOUT;
    };
    expect(await flush()).toBe(false);
    expect(notes).toEqual([`[roster] neatlogs: trace ${TRACE_ID} saved for retry`]);

    const req = JSON.parse(readFileSync(join(dir, `${TRACE_ID}.json`), "utf8")) as OtlpTraceRequest;
    const spans = req.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans.map((s) => s.name).sort()).toEqual(["coordinator", "replay attempt 1", "review"]);
    expect(spans.every((s) => s.traceId === TRACE_ID)).toBe(true);
    // The tree survives: TOOL → AGENT → WORKFLOW root.
    const byName = new Map(spans.map((s) => [s.name, s]));
    expect(byName.get("review")!.parentSpanId).toBeUndefined();
    expect(byName.get("coordinator")!.parentSpanId).toBe(byName.get("review")!.spanId);
    expect(byName.get("replay attempt 1")!.parentSpanId).toBe(byName.get("coordinator")!.spanId);
    const tool = byName.get("replay attempt 1")!.attributes;
    expect(tool).toContainEqual({ key: "roster.task", value: { stringValue: "T81" } });
    expect(tool).toContainEqual({ key: "roster.cost_usd", value: { doubleValue: 0.25 } });
    expect(tool).toContainEqual({ key: "neatlogs.span.kind", value: { stringValue: "TOOL" } });
  });

  test("a flush that reports dropped spans writes the spool file", async () => {
    await runReviewTrace();
    flushImpl = async () => {
      drops = 3;
      return { success: true, outcomes: [] };
    };
    expect(await flush()).toBe(true);
    expect(listSpool(dir).map((t) => t.traceId)).toEqual([TRACE_ID]);
    expect(listSpool(dir)[0]!.spans).toBe(3);
  });

  test("a clean flush writes nothing, and the next failed flush holds only its own spans", async () => {
    await runReviewTrace();
    expect(await flush()).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(notes).toEqual([]);

    await withSpan("WORKFLOW", "review", {}, async () => undefined);
    flushImpl = async () => ({ success: false, outcomes: [{ pipeline: "module", success: false, timedOut: true }] });
    expect(await flush()).toBe(false);
    expect(listSpool(dir)[0]!.spans).toBe(1);
  });

  test("the API key is scrubbed even from an attribute that carries it", async () => {
    await withSpan("WORKFLOW", "review", { repo: `leak-${KEY}` }, async () => undefined);
    flushImpl = async () => {
      throw TIMEOUT;
    };
    await flush();
    expect(allSpoolText()).toContain("leak-[redacted]");
    expect(allSpoolText()).not.toContain(KEY);
  });
});

describe("roster traces", () => {
  async function spoolOne(): Promise<string> {
    await runReviewTrace();
    flushImpl = async () => {
      throw TIMEOUT;
    };
    await flush();
    const body = readFileSync(join(dir, `${TRACE_ID}.json`), "utf8");
    printed = [];
    return body;
  }

  test("flushObs re-sends what the SDK lost at once when resend is on", async () => {
    await runReviewTrace();
    flushImpl = async () => {
      throw TIMEOUT;
    };
    const { fetch: f, calls } = fakeFetch([200]);
    await flushObs({ timeoutMs: 50, retries: 0, spoolDir: dir, notify: (m) => notes.push(m), log: () => {}, print: (m) => printed.push(m), resend: true, fetch: f });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers["content-type"]).toBe("application/x-protobuf");
    expect(existsSync(join(dir, `${TRACE_ID}.json`))).toBe(false);
    expect(printed).toContain(`trace ${TRACE_ID}: HTTP 200, sent`);
  });

  test("flushObs leaves the spool alone under bun test unless resend is on", async () => {
    await runReviewTrace();
    flushImpl = async () => {
      throw TIMEOUT;
    };
    await flush();
    expect(existsSync(join(dir, `${TRACE_ID}.json`))).toBe(true);
  });

  test("flush re-sends with x-api-key and deletes the file on 200", async () => {
    const body = await spoolOne();
    const { fetch: f, calls } = fakeFetch([200]);
    expect(await traces(["flush"], f)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://ingest.neatlogs.com/v1/traces");
    expect(calls[0]!.headers["x-api-key"]).toBe(KEY);
    expect(calls[0]!.headers["content-type"]).toBe("application/x-protobuf");
    // The body is OTLP protobuf; decoded back it is the spooled request, with hex ids as bytes.
    const Req = traceRequestProto();
    const decoded = Req.toObject(Req.decode(calls[0]!.body as Uint8Array), { longs: String, bytes: String }) as {
      resourceSpans: { scopeSpans: { spans: { traceId: string; name: string; startTimeUnixNano: string }[] }[] }[];
    };
    const sent = JSON.parse(body) as OtlpTraceRequest;
    const spans = decoded.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans.map((s) => s.name)).toEqual(sent.resourceSpans[0]!.scopeSpans[0]!.spans.map((s) => s.name));
    expect(Buffer.from(spans[0]!.traceId, "base64").toString("hex")).toBe(TRACE_ID);
    expect(spans[0]!.startTimeUnixNano).toBe(sent.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.startTimeUnixNano);
    expect(existsSync(join(dir, `${TRACE_ID}.json`))).toBe(false);
    expect(printed).toEqual([`trace ${TRACE_ID}: HTTP 200, sent`]);
  });

  test("a 500 is tried 3 times and the file is kept", async () => {
    await spoolOne();
    const { fetch: f, calls } = fakeFetch([500]);
    expect(await traces(["flush"], f)).toBe(1);
    expect(calls).toHaveLength(3);
    expect(existsSync(join(dir, `${TRACE_ID}.json`))).toBe(true);
    expect(printed).toEqual([`trace ${TRACE_ID}: HTTP 500, kept for retry`]);
  });

  test("a 500 then a 200 sends on the retry", async () => {
    await spoolOne();
    const { fetch: f, calls } = fakeFetch([500, 200]);
    expect(await traces(["flush"], f)).toBe(0);
    expect(calls).toHaveLength(2);
    expect(listSpool(dir)).toEqual([]);
  });

  test("a network error is retried and never prints the key", async () => {
    await spoolOne();
    let n = 0;
    const f = (async () => {
      n++;
      throw new Error(`connect failed for key ${KEY}`);
    }) as unknown as typeof fetch;
    expect(await traces(["flush"], f)).toBe(1);
    expect(n).toBe(3);
    expect(printed.join("\n")).not.toContain(KEY);
    expect(printed[0]).toContain("no response");
  });

  test("list shows saved traces; no key in any file or output", async () => {
    await spoolOne();
    expect(await traces(["list"], fakeFetch([200]).fetch)).toBe(0);
    expect(printed).toHaveLength(1);
    expect(printed[0]).toStartWith(`${TRACE_ID}  3 spans`);
    expect(allSpoolText()).not.toContain(KEY);
    expect(printed.join("\n")).not.toContain(KEY);
  });

  test("flush without NEATLOGS_API_KEY sends nothing", async () => {
    await spoolOne();
    const { fetch: f, calls } = fakeFetch([200]);
    const code = await runTraces(["flush", "--dir", dir], { fetch: f, env: {}, out: (m) => printed.push(m), err: (m) => printed.push(m) });
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(existsSync(join(dir, `${TRACE_ID}.json`))).toBe(true);
  });
});
