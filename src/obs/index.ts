// neatlogs instrumentation of Roster's own runs (DESIGN.md §"Observability (neatlogs)").
// One review = one trace: WORKFLOW root → AGENT coordinator → TOOL steps and attempts, plus a GUARDRAIL gate.
// Without NEATLOGS_API_KEY every call is a no-op and the wrapped work still runs.
import type { TraceOptions } from "neatlogs";
import { EvidenceLevel, FailureCode } from "../types.ts";
import { type SpanAttrs, type SpanKind, toAttributes } from "./attributes.ts";

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

function warnOnce(msg: string): void {
  if (warned) return;
  warned = true;
  console.warn(`[roster] observability disabled: ${msg}`);
}

/**
 * Starts neatlogs for this process. Resolves to true when tracing is live.
 * With NEATLOGS_API_KEY unset (or the SDK not installed) it resolves to false and warns once.
 */
export async function initObs(opts: { workflowName: string }): Promise<boolean> {
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
  return client.trace(options, async (span) => {
    for (const [key, value] of Object.entries(toAttributes(attrs))) span.setAttribute(key, value);
    if (sessionId !== undefined) span.setAttribute("session.id", sessionId);
    return fn(toObsSpan(span));
  });
}

/** Adapts an SDK span (an OpenTelemetry span) to ObsSpan. The trace id comes from spanContext(). */
function toObsSpan(span: NeatlogsSpan): ObsSpan {
  // A bare `traceId` field is honored too, for span stand-ins that carry one directly.
  const direct = (span as { traceId?: string }).traceId;
  return {
    setAttribute: (key, value) => void span.setAttribute(key, value),
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

/** Sends buffered spans. Call once before the process exits. A no-op when tracing is off. */
export async function flushObs(): Promise<void> {
  if (sdk) await sdk.flush();
}
