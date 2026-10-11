// Blind grading for the forward run (DESIGN.md §"Forward run"): random X/Y labels, a judge that sees only the
// labelled diffs, and the merge policy. Randomness is a seeded PRNG so every pick can be replayed from the logged seed.
import type { ChatMessage, LlmClient } from "../llm/types.ts";
import type { ForwardPair } from "../types.ts";

export type Side = "old" | "new";
export type Verdict = "X" | "Y" | "tie";

/** mulberry32: a small deterministic PRNG, so a logged seed reproduces labels and tie-breaks. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A per-pair seed derived from the run seed and the task id (FNV-1a), stable across resumes. */
export function pairSeed(runSeed: number, taskId: string): number {
  let h = (0x811c9dc5 ^ runSeed) >>> 0;
  for (const ch of taskId) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}

/** Which side is shown as X; the other is Y. */
export function assignLabels(random: () => number): Record<"X" | "Y", Side> {
  return random() < 0.5 ? { X: "old", Y: "new" } : { X: "new", Y: "old" };
}

/** Removes anything that names a setup or the branch it ran on, so the judge cannot tell the sides apart. */
export function scrub(text: string, hide: string[]): string {
  let out = text.replace(/forward\/[\w.-]+\/(old|new)/g, "<branch>");
  for (const h of hide.filter((s) => s.length > 0)) out = out.split(h).join("<setup>");
  return out;
}

const SYSTEM = `You compare two candidate changes, X and Y, for the same task. You know nothing about who or what wrote them.
Judge correctness against the task, then scope discipline, then simplicity. Reply with one line: "verdict: X", "verdict: Y" or "verdict: tie".`;

/** The judge's whole input: the task text and the two labelled diffs, nothing that identifies a setup. */
export function blindMessages(task: string, diffX: string, diffY: string, hide: string[] = []): ChatMessage[] {
  const body = [
    "Task:",
    scrub(task, hide),
    "",
    "=== Change X ===",
    scrub(diffX, hide),
    "",
    "=== Change Y ===",
    scrub(diffY, hide),
    "",
  ].join("\n");
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: body },
  ];
}

export function parseVerdict(text: string | null): Verdict {
  const m = [...(text ?? "").matchAll(/verdict:\s*(X|Y|tie)\b/gi)].at(-1);
  if (!m) return "tie";
  const v = m[1]!.toUpperCase();
  return v === "X" ? "X" : v === "Y" ? "Y" : "tie";
}

export interface BlindResult {
  labels: Record<"X" | "Y", Side>;
  verdict: Verdict;
  /** The preferred side, or null on a tie. */
  preferred: Side | null;
  /** The labelled input the judge saw, kept so logs and tests can show it was blind. */
  input: ChatMessage[];
}

/** Labels the two diffs at random, asks the judge, and maps the verdict back to a side. */
export async function blindJudge(
  llm: LlmClient,
  task: string,
  diffs: Record<Side, string>,
  random: () => number,
  hide: string[] = [],
): Promise<BlindResult> {
  const labels = assignLabels(random);
  const input = blindMessages(task, diffs[labels.X], diffs[labels.Y], hide);
  const res = await llm.chat({ messages: input, temperature: 0 });
  const verdict = parseVerdict(res.message.content);
  return { labels, verdict, preferred: verdict === "tie" ? null : labels[verdict], input };
}

export type MergeReason = NonNullable<ForwardPair["merged_reason"]>;
export type Secondary = NonNullable<ForwardPair["secondary"]>;

export interface MergeChoice {
  merged: Side | null;
  reason: MergeReason;
}

/**
 * Pass beats fail; both pass → the judge's preference; judge tie → a seeded random pick.
 * With `eligible` (amendment 8, build only: per side, suite passes and scope is ok), a both-fail pair merges the one
 * eligible side, or the judge's pick when both are; without it, or when neither is, nothing merges.
 */
export function chooseMerge(pass: Record<Side, boolean>, preferred: Side | null, random: () => number, eligible?: Record<Side, boolean>): MergeChoice {
  if (pass.old !== pass.new) return { merged: pass.old ? "old" : "new", reason: "pass_beats_fail" };
  if (!pass.old) {
    if (!eligible || (!eligible.old && !eligible.new)) return { merged: null, reason: "both_failed" };
    if (eligible.old !== eligible.new) return { merged: eligible.old ? "old" : "new", reason: "suite_scope" };
    if (preferred) return { merged: preferred, reason: "suite_scope_judge" };
    return { merged: random() < 0.5 ? "old" : "new", reason: "suite_scope_random_tie" };
  }
  if (preferred) return { merged: preferred, reason: "judge" };
  return { merged: random() < 0.5 ? "old" : "new", reason: "random_tie" };
}

/** The exploratory secondary outcome: among sides with suite and scope ok, the judge's pick (one eligible side wins outright). */
export function secondaryOutcome(eligible: Record<Side, boolean>, preferred: Side | null): Secondary {
  if (eligible.old && eligible.new) return preferred ?? "tie";
  if (eligible.old) return "old";
  if (eligible.new) return "new";
  return "none";
}
