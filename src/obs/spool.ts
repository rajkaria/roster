// Durable neatlogs traces (T81). Alongside the SDK, obs keeps a local copy of each run's span tree as the OTLP/JSON
// trace request the SDK would POST to <endpoint>/v1/traces. When a flush drops spans or fails, the trace is written
// to .roster/traces/<trace-id>.json; `roster traces flush` re-sends it later, encoded as OTLP protobuf (neatlogs
// ingest rejects OTLP/JSON with "Invalid protobuf payload"). The API key is never written here.
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

export const DEFAULT_SPOOL_DIR = join(".roster", "traces");
/** The SDK's default ingest base (neatlogs DEFAULT_INGEST_ENDPOINT); the SDK appends /v1/traces. */
export const DEFAULT_INGEST_ENDPOINT = "https://ingest.neatlogs.com";
export const TRACES_PATH = "/v1/traces";

type AttrScalar = string | number | boolean;

/** One finished span, as obs saw it. Ids are the SDK's own (OpenTelemetry hex ids). */
export interface RecordedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: string;
  startNs: bigint;
  endNs: bigint;
  attributes: Record<string, AttrScalar>;
  error?: string;
}

/** OTLP/JSON AnyValue. */
type OtlpValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
interface OtlpKeyValue {
  key: string;
  value: OtlpValue;
}

/** OTLP/JSON ExportTraceServiceRequest: the body of a POST to /v1/traces. */
export interface OtlpTraceRequest {
  resourceSpans: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: Array<{
      scope: { name: string };
      spans: Array<{
        traceId: string;
        spanId: string;
        parentSpanId?: string;
        name: string;
        kind: number;
        startTimeUnixNano: string;
        endTimeUnixNano: string;
        attributes: OtlpKeyValue[];
        status: { code: number; message?: string };
      }>;
    }>;
  }>;
}

const HEX_TRACE_ID = /^[0-9a-f]{32}$/;
const HEX_SPAN_ID = /^[0-9a-f]{16}$/;

function otlpValue(v: AttrScalar): OtlpValue {
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: v };
}

const keyValues = (attrs: Record<string, AttrScalar>): OtlpKeyValue[] =>
  Object.entries(attrs).map(([key, value]) => ({ key, value: otlpValue(value) }));

/** Builds the OTLP/JSON request for one trace's spans. SPAN_KIND_INTERNAL = 1; status OK = 1, ERROR = 2. */
export function toTraceRequest(spans: readonly RecordedSpan[], workflowName: string): OtlpTraceRequest {
  return {
    resourceSpans: [
      {
        resource: { attributes: keyValues({ "service.name": workflowName }) },
        scopeSpans: [
          {
            scope: { name: "roster" },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: 1,
              startTimeUnixNano: String(s.startNs),
              endTimeUnixNano: String(s.endNs),
              attributes: keyValues({ ...s.attributes, "neatlogs.span.kind": s.kind }),
              status: s.error === undefined ? { code: 1 } : { code: 2, message: s.error },
            })),
          },
        ],
      },
    ],
  };
}

const nowNs = (): bigint => BigInt(Date.now()) * 1_000_000n;

/**
 * Keeps the finished spans of every trace opened since the last flush. Parents come from the span that was active
 * when a span opened, tracked here rather than read off the SDK span.
 */
export class TraceRecorder {
  private readonly active = new AsyncLocalStorage<string>();
  private traces = new Map<string, RecordedSpan[]>();

  /**
   * Runs `fn` as one recorded span. Ids must be the SDK span's own; a span without a valid trace and span id
   * (a test stand-in, a non-recording span) is run but not recorded.
   */
  async record<T>(
    ids: { traceId?: string; spanId?: string },
    kind: string,
    name: string,
    attributes: () => Record<string, AttrScalar>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const { traceId, spanId } = ids;
    if (!traceId || !spanId || !HEX_TRACE_ID.test(traceId) || !HEX_SPAN_ID.test(spanId)) return fn();
    const parentSpanId = this.active.getStore();
    const startNs = nowNs();
    let error: string | undefined;
    try {
      return await this.active.run(spanId, fn);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const span: RecordedSpan = { traceId, spanId, name, kind, startNs, endNs: nowNs(), attributes: attributes() };
      if (parentSpanId) span.parentSpanId = parentSpanId;
      if (error !== undefined) span.error = error;
      const list = this.traces.get(traceId) ?? [];
      list.push(span);
      this.traces.set(traceId, list);
    }
  }

  /** Every recorded trace since the last take, oldest first; the recorder starts empty again. */
  take(): Array<{ traceId: string; spans: RecordedSpan[] }> {
    const out = [...this.traces].map(([traceId, spans]) => ({ traceId, spans }));
    this.traces = new Map();
    return out;
  }
}

/** Removes every occurrence of `secret` from `text`. A guard: nothing obs records should ever carry the key. */
function scrub(text: string, secret: string | undefined): string {
  return secret && secret.length > 0 ? text.split(secret).join("[redacted]") : text;
}

/** Writes one trace request to <dir>/<trace-id>.json and returns the path. The key, if given, is scrubbed out. */
export function saveTrace(dir: string, traceId: string, request: OtlpTraceRequest, secret?: string): string {
  if (!HEX_TRACE_ID.test(traceId)) throw new Error(`not a trace id: ${traceId}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${traceId}.json`);
  writeFileSync(path, `${scrub(JSON.stringify(request), secret)}\n`);
  return path;
}

export interface SpooledTrace {
  traceId: string;
  path: string;
  bytes: number;
  spans: number;
  savedAt: Date;
}

function countSpans(text: string): number {
  try {
    const req = JSON.parse(text) as OtlpTraceRequest;
    return req.resourceSpans.reduce((n, r) => n + r.scopeSpans.reduce((m, s) => m + s.spans.length, 0), 0);
  } catch {
    return 0;
  }
}

/** The saved traces in `dir`, oldest first. A missing directory is an empty spool. */
export function listSpool(dir: string = DEFAULT_SPOOL_DIR): SpooledTrace[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && HEX_TRACE_ID.test(f.slice(0, -5)))
    .map((f) => {
      const path = join(dir, f);
      const st = statSync(path);
      return { traceId: f.slice(0, -5), path, bytes: st.size, spans: countSpans(readFileSync(path, "utf8")), savedAt: st.mtime };
    })
    .sort((a, b) => a.savedAt.getTime() - b.savedAt.getTime() || a.traceId.localeCompare(b.traceId));
}

export interface SpoolFlushOptions {
  dir?: string;
  apiKey: string;
  /** Ingest base URL, or a full OTLP traces URL ending in /v1/traces. Default DEFAULT_INGEST_ENDPOINT. */
  endpoint?: string;
  fetch?: typeof fetch;
  /** Attempts per file. Default 3. */
  attempts?: number;
  /** Wait before the second attempt; it doubles each time after. Default 1000 ms. */
  backoffMs?: number;
  print?: (msg: string) => void;
}

export interface SpoolFlushResult {
  traceId: string;
  /** The last HTTP status, or null when no response came back. */
  status: number | null;
  sent: boolean;
}

/** The URL a trace is POSTed to, as the SDK builds it. */
export function tracesUrl(endpoint: string = DEFAULT_INGEST_ENDPOINT): string {
  const base = endpoint.replace(/\/+$/, "");
  return base.endsWith(TRACES_PATH) ? base : `${base}${TRACES_PATH}`;
}

type ProtoMessage = {
  fromObject(o: unknown): unknown;
  encode(m: unknown): { finish(): Uint8Array };
  decode(b: Uint8Array): unknown;
  toObject(m: unknown, o?: Record<string, unknown>): unknown;
};

/** The OTLP ExportTraceServiceRequest protobuf type, from the generated root the SDK's own exporter uses. */
export function traceRequestProto(): ProtoMessage {
  const root = createRequire(import.meta.url)("@opentelemetry/otlp-transformer/build/src/generated/root");
  return root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest as ProtoMessage;
}

const hexBytes = (hex: string): Uint8Array => Uint8Array.from((hex.match(/../g) ?? []).map((b) => Number.parseInt(b, 16)));

/** Encodes a spooled OTLP/JSON request as the protobuf body ingest accepts. Hex ids become bytes, as OTLP requires. */
export function encodeTraceRequest(req: OtlpTraceRequest): Uint8Array<ArrayBuffer> {
  const copy = structuredClone(req) as unknown as {
    resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[];
  };
  for (const rs of copy.resourceSpans)
    for (const ss of rs.scopeSpans)
      for (const span of ss.spans)
        for (const k of ["traceId", "spanId", "parentSpanId"])
          if (typeof span[k] === "string") span[k] = hexBytes(span[k] as string);
  const Req = traceRequestProto();
  return new Uint8Array(Req.encode(Req.fromObject(copy)).finish());
}

/** 429 and 5xx are worth another try; any other non-2xx answer will not change. */
const retryable = (status: number): boolean => status === 429 || status >= 500;

/**
 * Re-POSTs every saved trace with `x-api-key`. Each file gets up to `attempts` tries with exponential backoff, is
 * deleted on a 2xx and kept otherwise. Prints one line per file: its trace id and the HTTP status.
 */
export async function flushSpool(opts: SpoolFlushOptions): Promise<SpoolFlushResult[]> {
  const doFetch = opts.fetch ?? fetch;
  const attempts = Math.max(1, opts.attempts ?? 3);
  const backoffMs = opts.backoffMs ?? 1000;
  const print = opts.print ?? ((m: string) => console.log(m));
  const url = tracesUrl(opts.endpoint);
  const results: SpoolFlushResult[] = [];
  for (const t of listSpool(opts.dir)) {
    const body = encodeTraceRequest(JSON.parse(readFileSync(t.path, "utf8")) as OtlpTraceRequest);
    let status: number | null = null;
    let error = "";
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await Bun.sleep(backoffMs * 2 ** (i - 1));
      try {
        const res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/x-protobuf", "x-api-key": opts.apiKey },
          body,
        });
        status = res.status;
        error = "";
        if (res.ok || !retryable(res.status)) break;
      } catch (err) {
        status = null;
        error = scrub(err instanceof Error ? err.message : String(err), opts.apiKey);
      }
    }
    const sent = status !== null && status >= 200 && status < 300;
    if (sent) unlinkSync(t.path);
    print(`trace ${t.traceId}: ${status === null ? `no response (${error})` : `HTTP ${status}`}${sent ? ", sent" : ", kept for retry"}`);
    results.push({ traceId: t.traceId, status, sent });
  }
  return results;
}
