// neatlogs instrumentation of Roster's own runs (DESIGN.md §"Observability (neatlogs)").
// One review = one trace: WORKFLOW root → AGENT coordinator → TOOL steps and attempts, plus a GUARDRAIL gate.
// Without NEATLOGS_API_KEY every call is a no-op and the wrapped work still runs.
import type { TraceOptions } from "neatlogs";
import { EvidenceLevel, FailureCode } from "../types.ts";
import { type SpanAttrs, type SpanKind, capAttr, toAttributes } from "./attributes.ts";
import { DEFAULT_SPOOL_DIR, TraceRecorder, flushSpool, saveTrace, toTraceRequest } from "./spool.ts";

export type { SpanAttrs, SpanKind } from "./attributes.ts";

/** What the SDK hands a span body. `traceId` is the OpenTelemetry trace id, when the span has one. */
export interface ObsSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  traceId?: string;
}

/** The neatlogs SDK as its own type definitions declare it (`neatlogs` and `neatlogs/openai`). */
type NeatlogsModule = typeof import("neatlogs");
type WrapOpenAI = typeof import("neatlogs/openai").wrapOpenAI;
/** The OpenTelemetry span that trace()'s body receives. `neatlogs` also exports a `Span` decorator, so derive it. */
type NeatlogsSpan = Parameters<NeatlogsModule["trace"]>[1] extends (span: infer S) => unknown ? S : never;

const NOOP_SPAN: ObsSpan = { setAttribute() {} };

let sdk: NeatlogsModule | null = null;
let wrapOpenAI: WrapOpenAI | null = null;
let sessionId: string | undefined;
let warned = false;
let initPromise: Promise<boolean> | null = null;
let pendingSpans = 0;
let sentSpans = 0;
let failedSpans = 0;
/** Trace ids of the WORKFLOW roots opened since the last flush, printed when it ends. */
let rootTraces: string[] = [];
/** A local copy of every span tree since the last flush, spooled to disk when the SDK loses any of it (T81). */
let recorder = new TraceRecorder();
let workflowName = "roster";

/** Test hook: runs on `mod` as if initObs had started it (bun's mock.module cannot swap an SDK another file already loaded). */
export function _useSdkForTests(mod: unknown): void {
  sdk = mod as NeatlogsModule;
  initPromise = Promise.resolve(true);
}

/** Test hook: forgets the running SDK so a test can start from a clean process state. */
export function _resetObsForTests(): void {
  sdk = null;
  wrapOpenAI = null;
  sessionId = undefined;
  warned = false;
  initPromise = null;
  pendingSpans = sentSpans = failedSpans = 0;
  rootTraces = [];
  recorder = new TraceRecorder();
  workflowName = "roster";
}

function warnOnce(msg: string): void {
  if (warned) return;
  warned = true;
  console.warn(`[roster] observability disabled: ${msg}`);
}

/**
 * Starts neatlogs for this process. Resolves to true when tracing is live.
 * With NEATLOGS_API_KEY unset (or the SDK not installed) it resolves to false and warns once.
 */
export function initObs(opts: { workflowName: string }): Promise<boolean> {
  // One SDK init per process: later calls (any workflow name) reuse it; callers open their own root span.
  if (!initPromise) {
    const attempt = startSdk(opts);
    initPromise = attempt;
    // A failed start is not cached: a key set later may still start tracing.
    void attempt.then((ok) => {
      if (!ok && initPromise === attempt) initPromise = null;
    });
  }
  return initPromise;
}

async function startSdk(opts: { workflowName: string }): Promise<boolean> {
  const apiKey = process.env.NEATLOGS_API_KEY;
  if (!apiKey) {
    warnOnce("NEATLOGS_API_KEY is not set");
    return false;
  }
  try {
    const mod = await import("neatlogs");
    await mod.init({ apiKey, workflowName: opts.workflowName });
    wrapOpenAI = (await import("neatlogs/openai")).wrapOpenAI;
    sdk = mod;
    workflowName = opts.workflowName;
    return true;
  } catch (err) {
    warnOnce(`could not start neatlogs (${err instanceof Error ? err.message : String(err)})`);
    return false;
  }
}

/**
 * Wraps an OpenAI-compatible client so each of its calls becomes an LLM span. Returns the client unchanged
 * while tracing is off, so callers may wrap at call time (the CLI builds clients before initObs runs).
 */
export function traceOpenAI<T extends object>(client: T): T {
  return sdk && wrapOpenAI ? wrapOpenAI(client) : client;
}

/** True once initObs has enabled tracing. */
export function obsEnabled(): boolean {
  return sdk !== null;
}

/** Tags the current review. Every span opened after this carries it as `session.id`. */
export function setSession(reviewId: string): void {
  sessionId = reviewId;
}

/**
 * Runs `fn` inside one span of the given kind. The span is nested under whatever span is active,
 * so calling withSpan inside a WORKFLOW body builds the tree. Errors propagate after the span closes.
 */
export async function withSpan<T>(
  kind: SpanKind,
  name: string,
  attrs: SpanAttrs,
  fn: (span: ObsSpan) => Promise<T>,
): Promise<T> {
  if (!sdk) return fn(NOOP_SPAN);
  const client = sdk;
  // The SDK groups a review's traces by session on the WORKFLOW root; every span also carries it as an attribute.
  const options: TraceOptions = { name, kind };
  if (kind === "WORKFLOW" && sessionId !== undefined) options.sessionId = sessionId;
  pendingSpans += 1;
  return client.trace(options, async (span) => {
    // Every attribute also lands in the local copy the spool writes from.
    const local: Record<string, string | number | boolean> = {};
    const obsSpan = toObsSpan(span, local);
    for (const [key, value] of Object.entries(toAttributes(attrs))) obsSpan.setAttribute(key, value);
    if (sessionId !== undefined) obsSpan.setAttribute("session.id", sessionId);
    if (kind === "WORKFLOW" && obsSpan.traceId && !rootTraces.includes(obsSpan.traceId)) rootTraces.push(obsSpan.traceId);
    const ids = { traceId: obsSpan.traceId, spanId: span.spanContext?.().spanId };
    return recorder.record(ids, kind, name, () => local, () => fn(obsSpan));
  });
}

/** Adapts an SDK span (an OpenTelemetry span) to ObsSpan. The trace id comes from spanContext(). */
function toObsSpan(span: NeatlogsSpan, local: Record<string, string | number | boolean>): ObsSpan {
  // A bare `traceId` field is honored too, for span stand-ins that carry one directly.
  const direct = (span as { traceId?: string }).traceId;
  return {
    setAttribute: (key, value) => {
      const capped = capAttr(value);
      local[key] = capped;
      span.setAttribute(key, capped);
    },
    traceId: direct ?? span.spanContext?.().traceId,
  };
}

/** Outcome of one replay attempt, recorded as a finished TOOL span. */
export interface AttemptOutcome {
  failureCode?: FailureCode | FailureCode[];
  evidenceLevel?: EvidenceLevel;
  costUsd?: number;
}

/** Records one replay attempt as a TOOL span carrying its outcome. The span has no body work of its own. */
export async function recordAttempt(spanAttrs: SpanAttrs, attempt: number, outcome: AttemptOutcome): Promise<void> {
  await withSpan("TOOL", `replay attempt ${attempt}`, { ...spanAttrs, ...outcome, attempt }, async () => undefined);
}

/** How long the SDK may take to export on one flush attempt (flushAllDetailed's timeout). */
export const FLUSH_TIMEOUT_MS = 60_000;
/** Extra wait on top of the SDK's own timeout, so the SDK reports its outcome before ours fires. */
export const FLUSH_GRACE_MS = 5_000;

export interface FlushOptions {
  /** Per attempt. Default FLUSH_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Extra attempts after the first. Default 1. */
  retries?: number;
  /** Where the one failure line goes. Default console.warn. */
  log?: (msg: string) => void;
  /** Where flushObs's export report and trace ids go. Default console.log. */
  print?: (msg: string) => void;
  /** Where a failed or lossy flush spools its traces. Default DEFAULT_SPOOL_DIR. */
  spoolDir?: string;
  /** Where the "saved for retry" lines go. Default console.error. */
  notify?: (msg: string) => void;
  /**
   * Re-send the spooled traces at once, as OTLP protobuf over fetch, when the SDK lost spans. Under Bun the SDK's
   * own OTLP exporter times out on every export, so this is how a run's traces reach neatlogs. Default: on, except
   * under `bun test` (NODE_ENV=test), where tests opt in.
   */
  resend?: boolean;
  /** The fetch the re-send uses. Default the global fetch. */
  fetch?: typeof fetch;
}

/** What flushAllDetailed resolves to (neatlogs FlushAllResult). */
interface DetailedFlush {
  success: boolean;
  outcomes: Array<{ pipeline: string; success: boolean; timedOut: boolean; error?: string }>;
}

const isDetailed = (r: unknown): r is DetailedFlush =>
  typeof r === "object" && r !== null && typeof (r as DetailedFlush).success === "boolean" && Array.isArray((r as DetailedFlush).outcomes);

/** Why a detailed flush failed, from the SDK's per-pipeline outcomes. */
function detailedReason(r: DetailedFlush): string {
  const bad = r.outcomes.filter((o) => !o.success);
  if (bad.length === 0) return "the SDK reported a failed export";
  return bad.map((o) => `${o.pipeline}: ${o.timedOut ? "timed out" : (o.error ?? "failed")}`).join("; ");
}

/**
 * Runs `flush` until it succeeds, each attempt bounded by a timeout. A throw, a timeout or a `false` result is a
 * failed attempt. When every attempt fails it logs one line and resolves to false; it never throws.
 */
export function flushWithRetry(flush: () => Promise<unknown>, opts: FlushOptions = {}): Promise<boolean> {
  return flushCounted(flush, opts, 0);
}

async function flushCounted(flush: () => Promise<unknown>, opts: FlushOptions, batch: number): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? FLUSH_TIMEOUT_MS;
  const attempts = 1 + (opts.retries ?? 1);
  let reason = "";
  for (let i = 0; i < attempts; i++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((res) => {
      timer = setTimeout(() => res("timeout"), timeoutMs);
    });
    try {
      const r = await Promise.race([Promise.resolve().then(flush), timeout]);
      if (r === "timeout") reason = `timed out after ${timeoutMs / 1000} s`;
      else if (r === false) reason = "the SDK reported a failed export";
      else if (isDetailed(r) && !r.success) reason = detailedReason(r);
      else {
        sentSpans += batch;
        pendingSpans -= batch;
        return true;
      }
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }
  }
  failedSpans += batch;
  pendingSpans -= batch;
  (opts.log ?? console.warn)(
    `[roster] neatlogs flush failed after ${attempts} attempts (${reason}); ${sentSpans} spans sent, ${failedSpans} failed; traces may be incomplete`,
  );
  return false;
}

/** Spans the SDK says it has lost so far (queue drops, failed exports, masked drops), or null when it cannot say. */
function sdkDrops(client: NeatlogsModule): number | null {
  if (typeof client.getDeliveryDiagnostics !== "function") return null;
  try {
    const d = client.getDeliveryDiagnostics();
    return d.spanQueueDrops + d.spanExportFailures + d.maskedSpanDrops;
  } catch {
    return null;
  }
}

/**
 * Sends buffered spans. Call once before the process exits. A no-op when tracing is off.
 * Prints what the SDK exported and dropped, then the trace id of every WORKFLOW root opened since the last flush.
 * Never throws: a failed flush logs one line, so it cannot change the exit code.
 */
export async function flushObs(opts: FlushOptions = {}): Promise<boolean> {
  if (!sdk) return true;
  const client = sdk;
  const timeoutMs = opts.timeoutMs ?? FLUSH_TIMEOUT_MS;
  const print = opts.print ?? ((m: string) => console.log(m));
  const batch = pendingSpans;
  const traces = rootTraces;
  rootTraces = [];
  const dropsBefore = sdkDrops(client);
  // flushAllDetailed takes the SDK timeout and names the pipeline that failed; SDK builds (and test stand-ins)
  // without it fall back to flushAll, then flush(). Our own timeout waits a little longer so the SDK answers first.
  // The SDK reports no per-span result, so "exported" is the spans opened since the last flush, less the SDK's drops.
  const ok = await flushCounted(
    () =>
      typeof client.flushAllDetailed === "function"
        ? client.flushAllDetailed(timeoutMs)
        : typeof client.flushAll === "function"
          ? client.flushAll(timeoutMs)
          : client.flush(),
    { ...opts, timeoutMs: timeoutMs + FLUSH_GRACE_MS },
    batch,
  );
  const dropsAfter = sdkDrops(client);
  const dropped = dropsBefore !== null && dropsAfter !== null ? Math.max(0, dropsAfter - dropsBefore) : null;
  const exported = ok ? Math.max(0, batch - (dropped ?? 0)) : 0;
  print(`[roster] neatlogs: ${exported} spans exported, ${dropped ?? "unknown"} dropped${ok ? "" : " (flush failed)"}`);
  const lost = !ok || (dropped ?? 0) > 0;
  spoolLost(lost, opts);
  for (const id of traces) print(`[roster] neatlogs trace ${id}`);
  if (lost && (opts.resend ?? process.env.NODE_ENV !== "test")) await resendSpool(opts, print);
  return ok;
}

/** Sends the spool now (see FlushOptions.resend). A trace that arrives leaves the spool. Never throws. */
async function resendSpool(opts: FlushOptions, print: (msg: string) => void): Promise<void> {
  const apiKey = process.env.NEATLOGS_API_KEY;
  if (!apiKey) return;
  try {
    print("[roster] neatlogs: re-sending what the SDK lost (OTLP protobuf)");
    await flushSpool({ dir: opts.spoolDir, apiKey, fetch: opts.fetch, attempts: 2, backoffMs: 500, print });
  } catch (err) {
    print(`[roster] neatlogs: re-send failed (${err instanceof Error ? err.message : String(err)}); run \`roster traces flush\``);
  }
}

/**
 * Hands this flush's recorded span trees to the spool when the SDK failed or dropped spans, and forgets them
 * otherwise. Each saved trace gets one line; `roster traces flush` re-sends it. Never throws.
 */
function spoolLost(lost: boolean, opts: FlushOptions): void {
  const taken = recorder.take();
  if (!lost) return;
  const notify = opts.notify ?? ((m: string) => console.error(m));
  for (const { traceId, spans } of taken) {
    try {
      saveTrace(opts.spoolDir ?? DEFAULT_SPOOL_DIR, traceId, toTraceRequest(spans, workflowName), process.env.NEATLOGS_API_KEY);
      notify(`[roster] neatlogs: trace ${traceId} saved for retry`);
    } catch (err) {
      notify(`[roster] neatlogs: trace ${traceId} could not be saved (${err instanceof Error ? err.message : String(err)})`);
    }
  }
}
