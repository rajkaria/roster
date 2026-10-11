// Plain words for a gate decision or a suspect flag (DESIGN.md §"Gate", §"Review").
//
// A founder reads these sentences instead of a verdict object. Two rules hold for every string here:
// - Failure codes are always spelled out, so "F1" never reaches the reader without "edited existing tests".
// - A suspect stays a suspect: the evidence is observational, so the wording never claims a setup is worse.
import { FailureCode } from "../types.ts";

/** What each failure code means, in the words of docs/DESIGN.md §"Grade" (F1–F7). */
export const FAILURE_PHRASES: Readonly<Record<FailureCode, string>> = {
  [FailureCode.F1]: "edited existing tests",
  [FailureCode.F2]: "never ran tests",
  [FailureCode.F3]: "suite regression",
  [FailureCode.F4]: "stopped early",
  [FailureCode.F5]: "loop, timeout or turn cap",
  [FailureCode.F6]: "environment or setup error; the task is excluded and resampled",
  [FailureCode.F7]: "off-scope edits",
};

/** A gate decision as `gate()` reports it, narrowed to the two verdicts that carry a word for the reader. */
export interface GateDecision {
  candidate: string;
  verdict: "promote" | "reject";
  reasons: string[];
  /** Task ids the incumbent passed and the candidate failed, after reruns. */
  regressions: string[];
}

/** A suspect call as `suspect()` reports it. `or` and `p` are absent when the call has no matched comparison. */
export interface SuspectCall {
  setupId: string | null;
  or?: number;
  p?: number;
  /** Mature sessions of the reported setup. */
  n: number;
  reason: string;
}

const CODE = /\bF[1-7]\b/g;

/** "F1" → "edited existing tests (F1)"; a sentence keeps its text and has each code inside it spelled out. */
function spell(reason: string): string {
  const phrase = FAILURE_PHRASES[reason as FailureCode];
  if (phrase !== undefined) return `${phrase} (${reason})`;
  return reason.replace(CODE, (code) => `${FAILURE_PHRASES[code as FailureCode]} (${code})`);
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** One founder-readable paragraph for a gate decision. A rejection names every task it regressed. */
export function explainGate(d: GateDecision): string {
  const sentences: string[] = [];
  if (d.verdict === "promote") {
    sentences.push(`${d.candidate} passed the gate, so it is promoted over the setup you run today.`);
  } else {
    sentences.push(`${d.candidate} failed the gate, so it does not replace the setup you run today.`);
  }

  const reasons = d.reasons.map(spell);
  if (reasons.length > 0) sentences.push(`Why: ${reasons.join("; ")}.`);

  if (d.regressions.length > 0) {
    sentences.push(
      `It regressed ${d.regressions.length} ${plural(d.regressions.length, "task", "tasks")} that the current setup ` +
        `passes: ${d.regressions.join(", ")}.`,
    );
  } else if (d.verdict === "reject") {
    sentences.push("No task that the current setup passes regressed, so the reason above is what sank it.");
  }
  return sentences.join(" ");
}

/** "1.50" / "0.0400"; a missing number is left out rather than guessed. */
function num(v: number | undefined, digits: number): string | null {
  return v === undefined ? null : v.toFixed(digits);
}

/** One founder-readable paragraph for a suspect call. Never says a setup is worse: the evidence is observational. */
export function explainSuspect(s: SuspectCall): string {
  const stats = [
    num(s.or, 2) === null ? null : `odds ratio ${num(s.or, 2)}`,
    num(s.p, 4) === null ? null : `p ${num(s.p, 4)}`,
  ].filter((x): x is string => x !== null);
  const over = `${s.n} mature ${plural(s.n, "session", "sessions")}`;

  if (s.setupId === null) {
    const tail = stats.length > 0 ? ` (${stats.join(", ")} over ${over})` : ` (over ${over})`;
    return (
      `No setup stands out: nothing is flagged as the suspect${tail}. ` +
      `The reason recorded is: ${s.reason}. This is observational evidence only, so treat it as a prompt to look, ` +
      `not as a verdict on any setup.`
    );
  }

  const tail = stats.length > 0 ? ` (${stats.join(", ")}, over ${over})` : ` (over ${over})`;
  return (
    `Setup ${s.setupId} is the suspect${tail}. ` +
    `The reason recorded is: ${s.reason}. This is observational evidence only: it points at a setup worth ` +
    `reviewing, and only a controlled replay can confirm it.`
  );
}
