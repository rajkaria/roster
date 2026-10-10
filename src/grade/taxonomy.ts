// Failure taxonomy classifier (DESIGN.md §"Failure taxonomy"). Explains why a failed replay failed:
// F1–F7 with evidence strings, from the run's tool calls (stream-json transcript) and its grade.
//
//   const failures = classify(replay, grade, parseTranscript(streamJson));
//
// A passing replay has no failures, so classify returns [] for it. An F6 (environment) failure
// excludes the task, so it is returned alone: the other codes say nothing about the agent then.

import { FailureCode } from "../types.ts";
import type { Replay } from "../types.ts";
import type { GradeResult } from "./index.ts";

export interface ToolCall {
  id: string;
  /** 1-based index of the assistant message that made the call. */
  turn: number;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolUseId: string;
  isError: boolean;
  text: string;
}

/** The harness's closing `result` event. */
export interface RunResult {
  subtype: string;
  isError: boolean;
  numTurns: number | null;
  terminalReason: string | null;
}

export interface Transcript {
  calls: ToolCall[];
  results: Map<string, ToolResult>;
  /** Text of the last assistant message, "" when it had none. */
  finalText: string;
  /** Distinct assistant messages. */
  turns: number;
  /** null when the run never emitted a result event (killed mid-run). */
  result: RunResult | null;
}

export interface Classified {
  code: FailureCode;
  evidence: string[];
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const INSTALL_OR_BUILD =
  /\b(bun|npm|pnpm|yarn)\s+(install|i|add|ci)\b|\b(bun|npm|pnpm|yarn)\s+run\s+build\b|\bbun\s+build\b|\btsc\b|\bpip3?\s+install\b|\bgo\s+(mod\s+download|build)\b/;
const TEST_RUN = /\b(bun\s+test|(npm|pnpm|yarn)\s+(run\s+)?test|pytest|go\s+test|cargo\s+test)\b/;
const ERROR_TEXT = /\b(ERR!|error:|E404|ENOTFOUND|EAI_AGAIN|Could not resolve|failed to)\b/i;
const STOP_TEXT = /\b(cannot|can't|unable to|not able to|should i|would you like|do you want)\b|\?\s*$/i;
const LOOP_MIN_REPEATS = 3;

const str = (v: unknown) => (typeof v === "string" ? v : "");

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text")
    .map((b) => str(b.text))
    .join("\n");
}

/**
 * Parses a `claude -p --output-format stream-json --verbose` transcript. A line cut off by a kill is
 * skipped, so a truncated run still classifies.
 */
export function parseTranscript(jsonl: string): Transcript {
  const calls: ToolCall[] = [];
  const results = new Map<string, ToolResult>();
  const seenMessages = new Set<string>();
  let turns = 0;
  let finalText = "";
  let result: RunResult | null = null;
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev?.type === "assistant") {
      const msgId = str(ev.message?.id) || `anon-${turns + 1}`;
      if (!seenMessages.has(msgId)) {
        seenMessages.add(msgId);
        turns++;
      }
      const blocks: any[] = Array.isArray(ev.message?.content) ? ev.message.content : [];
      finalText = blockText(blocks);
      for (const b of blocks) {
        if (b?.type === "tool_use") calls.push({ id: str(b.id), turn: turns, name: str(b.name), input: b.input ?? {} });
      }
    } else if (ev?.type === "user") {
      const blocks: any[] = Array.isArray(ev.message?.content) ? ev.message.content : [];
      for (const b of blocks) {
        if (b?.type === "tool_result") {
          const toolUseId = str(b.tool_use_id);
          results.set(toolUseId, { toolUseId, isError: b.is_error === true, text: blockText(b.content) });
        }
      }
    } else if (ev?.type === "result") {
      result = {
        subtype: str(ev.subtype),
        isError: ev.is_error === true,
        numTurns: typeof ev.num_turns === "number" ? ev.num_turns : null,
        terminalReason: str(ev.terminal_reason ?? ev.stop_reason) || null,
      };
    }
  }
  return { calls, results, finalText, turns, result };
}

const isBash = (c: ToolCall) => c.name === "Bash" && typeof c.input.command === "string";
const bashCmd = (c: ToolCall) => str(c.input.command);
const editPath = (c: ToolCall) => str(c.input.file_path) || str(c.input.notebook_path);
/** Matches a grader path (repo-relative) against a tool call path (absolute inside the sandbox, or relative). */
const samePath = (called: string, repoPath: string) => called === repoPath || called.endsWith(`/${repoPath}`);
const firstLine = (s: string) => s.split("\n").find((l) => l.trim() !== "")?.trim().slice(0, 160) ?? "";
const snippet = (s: string) => `"${s.replace(/\s+/g, " ").trim().slice(0, 120)}"`;

/** The turn of the first edit call that touched `repoPath`, or undefined. */
function editTurn(t: Transcript, repoPath: string): number | undefined {
  return t.calls.find((c) => EDIT_TOOLS.has(c.name) && samePath(editPath(c), repoPath))?.turn;
}

/** Classifies a replay. Returns codes in F1..F7 order, each with the evidence that supports it. */
export function classify(replay: Pick<Replay, "verdict">, grade: GradeResult | null, transcript: Transcript): Classified[] {
  if (replay.verdict === "pass") return [];
  const found = new Map<FailureCode, string[]>();
  const add = (code: FailureCode, ...ev: string[]) => found.set(code, [...(found.get(code) ?? []), ...ev]);
  const t = transcript;

  // F6 first: an install or build that failed before the agent's first edit excludes the task.
  const firstEdit = t.calls.findIndex((c) => EDIT_TOOLS.has(c.name));
  const envFail = t.calls.find((c, i) => {
    if (firstEdit >= 0 && i >= firstEdit) return false;
    if (!isBash(c) || !INSTALL_OR_BUILD.test(bashCmd(c))) return false;
    const r = t.results.get(c.id);
    return r !== undefined && (r.isError || ERROR_TEXT.test(r.text));
  });
  if (envFail) {
    const r = t.results.get(envFail.id);
    add(FailureCode.F6, `\`${bashCmd(envFail)}\` failed at turn ${envFail.turn} before any edit: ${firstLine(r?.text ?? "")}`);
    return [{ code: FailureCode.F6, evidence: found.get(FailureCode.F6)! }];
  }

  // F1: the grader found a pre-existing test file deleted or changed (not just appended to).
  for (const v of grade?.violations ?? []) {
    if (v.code !== FailureCode.F1) continue;
    const turn = editTurn(t, v.path);
    add(FailureCode.F1, turn === undefined ? `${v.path}: ${v.detail}` : `edited ${v.path} at turn ${turn} (${v.detail})`);
  }

  // F2: no test command was ever run.
  if (!t.calls.some((c) => isBash(c) && TEST_RUN.test(bashCmd(c)))) {
    add(FailureCode.F2, `no test command in ${t.calls.length} tool calls`);
  }

  // F3: the full suite failed on the agent's tree.
  if (grade && !grade.suitePass) add(FailureCode.F3, "full suite failed on the agent's tree");

  // F4: the run ended normally, the hidden acceptance tests failed, and the last message is a stop or a question.
  if (t.result && !t.result.isError && t.result.subtype === "success" && grade && !grade.hiddenPass && STOP_TEXT.test(t.finalText)) {
    add(FailureCode.F4, `stopped at turn ${t.turns} with hidden tests failing: ${snippet(t.finalText)}`);
  }

  // F5: turn cap, spend cap, timeout (no result event), or a loop of identical tool calls.
  if (t.result === null) add(FailureCode.F5, "no result event: the run was killed (timeout)");
  else if (t.result.subtype === "error_max_turns") add(FailureCode.F5, `hit turn cap after ${t.result.numTurns ?? t.turns} turns`);
  else if (/budget/i.test(t.result.subtype)) add(FailureCode.F5, `hit spend cap (${t.result.subtype})`);
  for (let i = 0; i < t.calls.length; ) {
    const key = (c: ToolCall) => `${c.name} ${JSON.stringify(c.input)}`;
    let j = i + 1;
    while (j < t.calls.length && key(t.calls[j]!) === key(t.calls[i]!)) j++;
    if (j - i >= LOOP_MIN_REPEATS) {
      const c = t.calls[i]!;
      add(FailureCode.F5, `repeated ${c.name} ${j - i}x from turn ${c.turn} to turn ${t.calls[j - 1]!.turn}`);
    }
    i = j;
  }

  // F7: the grader found edits outside the directories the original change touched.
  for (const v of grade?.violations ?? []) {
    if (v.code !== FailureCode.F7) continue;
    const turn = editTurn(t, v.path);
    add(FailureCode.F7, turn === undefined ? `${v.path}: ${v.detail}` : `edited ${v.path} at turn ${turn} (${v.detail})`);
  }

  return Object.values(FailureCode)
    .filter((code) => found.has(code))
    .map((code) => ({ code, evidence: found.get(code)! }));
}
