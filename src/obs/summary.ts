// Focused failure context for the coordinator: a span tree boiled down to counts, errors and cost (DESIGN.md §"Observability (neatlogs)").
export type SpanNode = {
  name: string;
  kind: string;
  status: "ok" | "error";
  attributes: Record<string, unknown>;
  durationMs: number;
  children: SpanNode[];
};

export type TraceSummary = {
  toolCalls: number;
  errors: { name: string; message?: string }[];
  retries: number;
  costUsd: number | null;
  slowest: { name: string; durationMs: number } | null;
  oneLine: string;
};

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function summariseTrace(root: SpanNode): TraceSummary {
  let toolCalls = 0;
  let retries = 0;
  let costSum = 0;
  let hasCost = false;
  let slowest: TraceSummary["slowest"] = null;
  const errors: TraceSummary["errors"] = [];

  const visit = (span: SpanNode): void => {
    if (span.kind === "TOOL") {
      toolCalls++;
      if (!slowest || span.durationMs > slowest.durationMs) slowest = { name: span.name, durationMs: span.durationMs };
    }
    if (span.status === "error") {
      const message = span.attributes["error.message"];
      errors.push(typeof message === "string" ? { name: span.name, message } : { name: span.name });
    }
    const attempt = span.attributes["roster.attempt"];
    if (typeof attempt === "number" && attempt > 1) retries++;
    const cost = span.attributes["roster.cost_usd"];
    if (typeof cost === "number" && Number.isFinite(cost)) {
      costSum += cost;
      hasCost = true;
    }
    for (const child of span.children) visit(child);
  };
  visit(root);

  const costUsd = hasCost ? costSum : null;
  const parts = [count(toolCalls, "tool call", "tool calls")];
  if (errors.length > 0) parts.push(`${count(errors.length, "error", "errors")} (${errors.map((e) => e.name).join(", ")})`);
  if (retries > 0) parts.push(count(retries, "retry", "retries"));
  if (costUsd !== null) parts.push(`$${costUsd.toFixed(2)}`);

  return { toolCalls, errors, retries, costUsd, slowest, oneLine: parts.join(", ") };
}
