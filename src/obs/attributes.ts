// roster.* span attribute names (DESIGN.md §"Observability (neatlogs)"). Names are a contract; do not rename.
import type { SpanKind as NeatlogsSpanKind } from "neatlogs";
import { EvidenceLevel, FailureCode } from "../types.ts";

export const ATTR = {
  setup: "roster.setup",
  task: "roster.task",
  attempt: "roster.attempt",
  failureCode: "roster.failure_code",
  evidenceLevel: "roster.evidence_level",
  repo: "roster.repo",
  costUsd: "roster.cost_usd",
} as const;

/** The span kinds the design names: WORKFLOW root, AGENT coordinator, TOOL steps, GUARDRAIL gate. A subset of the SDK's kinds. */
export type SpanKind = Extract<NeatlogsSpanKind, "WORKFLOW" | "AGENT" | "TOOL" | "GUARDRAIL">;

/** Attributes a Roster span can carry. Every field is optional; unset fields are not written. */
export interface SpanAttrs {
  setup?: string;
  task?: string;
  attempt?: number;
  failureCode?: FailureCode | FailureCode[];
  evidenceLevel?: EvidenceLevel;
  repo?: string;
  costUsd?: number;
}

export type AttrValue = string | number;

/** Maps Roster's camelCase fields to the exact `roster.*` attribute names, dropping unset fields. */
export function toAttributes(attrs: SpanAttrs): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {};
  if (attrs.setup !== undefined) out[ATTR.setup] = attrs.setup;
  if (attrs.task !== undefined) out[ATTR.task] = attrs.task;
  if (attrs.attempt !== undefined) out[ATTR.attempt] = attrs.attempt;
  if (attrs.failureCode !== undefined) {
    out[ATTR.failureCode] = Array.isArray(attrs.failureCode) ? attrs.failureCode.join(",") : attrs.failureCode;
  }
  if (attrs.evidenceLevel !== undefined) out[ATTR.evidenceLevel] = attrs.evidenceLevel;
  if (attrs.repo !== undefined) out[ATTR.repo] = attrs.repo;
  if (attrs.costUsd !== undefined) out[ATTR.costUsd] = attrs.costUsd;
  return out;
}
