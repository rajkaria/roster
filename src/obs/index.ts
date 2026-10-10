// neatlogs instrumentation of Roster's own runs (DESIGN.md §"Observability (neatlogs)").
// One review = one trace: WORKFLOW root → AGENT coordinator → TOOL steps and attempts, plus a GUARDRAIL gate.
// Without NEATLOGS_API_KEY every call is a no-op and the wrapped work still runs.
import { EvidenceLevel, FailureCode } from "../types.ts";
import { type SpanAttrs, type SpanKind, toAttributes } from "./attributes.ts";

export type { SpanAttrs, SpanKind } from "./attributes.ts";

/** What the SDK hands a span body. `traceId` is set only when the SDK exposes OpenTelemetry-style span context. */
export interface ObsSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  traceId?: string;
}

/** The subset of the neatlogs SDK this module uses (docs.neatlogs.com/sdk/typescript). */
interface NeatlogsSdk {
  init(opts: { apiKey?: string; workflowName: string }): Promise<unknown>;
  trace<T>(opts: { name: string; kind: SpanKind }, fn: (span: ObsSpan) => Promise<T>): Promise<T>;
  flush(): Promise<void>;
}

// Resolved at runtime, not via a static import: the package is optional, and a missing one must be a no-op.
const SDK_MODULE = "neatlogs";

const NOOP_SPAN: ObsSpan = { setAttribute() {} };

let sdk: NeatlogsSdk | null = null;
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
    const mod = (await import(SDK_MODULE)) as NeatlogsSdk;
    await mod.init({ apiKey, workflowName: opts.workflowName });
    sdk = mod;
    return true;
  } catch (err) {
    warnOnce(`could not load ${SDK_MODULE} (${err instanceof Error ? err.message : String(err)})`);
    return false;
  }
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
  return client.trace({ name, kind }, async (span) => {
    for (const [key, value] of Object.entries(toAttributes(attrs))) span.setAttribute(key, value);
    if (sessionId !== undefined) span.setAttribute("session.id", sessionId);
    return fn(span);
  });
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
