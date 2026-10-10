import { describe, expect, test } from "bun:test";
import { classify, parseTranscript } from "../src/grade/taxonomy.ts";
import type { GradeResult } from "../src/grade/index.ts";
import { FailureCode } from "../src/types.ts";

// Logic tests. The lines below are written in the stream-json shape that `claude -p` emits, but they
// are NOT captured transcripts: acceptance needs fixtures captured from real spike runs (see the PR).

let msg = 0;
const assistant = (...blocks: object[]) => JSON.stringify({ type: "assistant", message: { id: `msg_${++msg}`, content: blocks } });
const text = (t: string) => ({ type: "text", text: t });
const call = (id: string, name: string, input: object) => ({ type: "tool_use", id, name, input });
const toolResult = (id: string, content: string, isError = false) =>
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });
const result = (subtype: string, extra: object = {}) =>
  JSON.stringify({ type: "result", subtype, is_error: subtype !== "success", num_turns: msg, ...extra });
const jsonl = (...lines: string[]) => lines.join("\n") + "\n";

const SANDBOX = "/private/var/ws";
const grade = (over: Partial<GradeResult> = {}): GradeResult => ({
  hiddenPass: true,
  suitePass: true,
  scopeOk: true,
  violations: [],
  perTest: [],
  ...over,
});
const failed = { verdict: "hidden_tests_failed" as const };

describe("parseTranscript", () => {
  test("counts distinct assistant messages, pairs results, keeps the closing result", () => {
    msg = 0;
    const t = parseTranscript(
      jsonl(
        JSON.stringify({ type: "system", subtype: "init" }),
        assistant(text("Reading the file."), call("a", "Read", { file_path: "src/x.ts" })),
        toolResult("a", "export const x = 1;"),
        assistant(call("b", "Bash", { command: "bun test" })),
        toolResult("b", "1 pass", false),
        assistant(text("Done.")),
        result("success", { terminal_reason: "end_turn" }),
      ),
    );
    expect(t.turns).toBe(3);
    expect(t.calls.map((c) => [c.name, c.turn])).toEqual([
      ["Read", 1],
      ["Bash", 2],
    ]);
    expect(t.results.get("b")?.text).toBe("1 pass");
    expect(t.finalText).toBe("Done.");
    expect(t.result).toEqual({ subtype: "success", isError: false, numTurns: 3, terminalReason: "end_turn" });
  });

  test("skips a line cut off by a kill and reports no result", () => {
    msg = 0;
    const t = parseTranscript(jsonl(assistant(call("a", "Read", { file_path: "a.ts" })), '{"type":"assis'));
    expect(t.calls).toHaveLength(1);
    expect(t.result).toBeNull();
  });
});

describe("classify", () => {
  test("a passing replay has no failure codes", () => {
    msg = 0;
    const t = parseTranscript(jsonl(assistant(call("a", "Bash", { command: "bun test" })), result("success")));
    expect(classify({ verdict: "pass" }, grade(), t)).toEqual([]);
  });

  test("F1 names the edited test file and its turn", () => {
    msg = 0;
    const t = parseTranscript(
      jsonl(
        assistant(call("a", "Read", { file_path: "tests/foo.test.ts" })),
        assistant(call("b", "Edit", { file_path: `${SANDBOX}/tests/foo.test.ts`, old_string: "a", new_string: "b" })),
        toolResult("b", "ok"),
        assistant(call("c", "Bash", { command: "bun test" })),
        result("success"),
      ),
    );
    const g = grade({
      hiddenPass: false,
      violations: [{ code: FailureCode.F1, path: "tests/foo.test.ts", detail: "pre-existing test cases modified" }],
    });
    const out = classify(failed, g, t);
    expect(out).toEqual([
      { code: FailureCode.F1, evidence: ["edited tests/foo.test.ts at turn 2 (pre-existing test cases modified)"] },
    ]);
  });

  test("F2 fires when no test command was run, and not when one was", () => {
    msg = 0;
    const never = parseTranscript(jsonl(assistant(call("a", "Edit", { file_path: "src/x.ts" })), toolResult("a", "ok"), result("success")));
    expect(classify(failed, grade({ hiddenPass: false }), never).map((c) => c.code)).toEqual([FailureCode.F2]);

    msg = 0;
    const ran = parseTranscript(
      jsonl(assistant(call("a", "Edit", { file_path: "src/x.ts" })), assistant(call("b", "Bash", { command: "bun test test/x.test.ts" })), result("success")),
    );
    expect(classify(failed, grade({ hiddenPass: false }), ran).map((c) => c.code)).not.toContain(FailureCode.F2);
  });

  test("F3 fires when the full suite fails on the agent's tree", () => {
    msg = 0;
    const t = parseTranscript(jsonl(assistant(call("a", "Bash", { command: "bun test" })), result("success")));
    expect(classify(failed, grade({ suitePass: false, hiddenPass: false }), t).map((c) => c.code)).toEqual([FailureCode.F3]);
  });

  test("F4 fires when the run ends on a stop or a question while hidden tests fail", () => {
    msg = 0;
    const t = parseTranscript(
      jsonl(
        assistant(call("a", "Bash", { command: "bun test" })),
        assistant(text("I cannot change src/ under these rules. Should I stop here?")),
        result("success"),
      ),
    );
    const out = classify(failed, grade({ hiddenPass: false }), t);
    expect(out.map((c) => c.code)).toEqual([FailureCode.F4]);
    expect(out[0]?.evidence[0]).toContain("stopped at turn 2");
  });

  test("F5 fires on the turn cap", () => {
    msg = 0;
    const t = parseTranscript(
      jsonl(assistant(call("a", "Bash", { command: "bun test" })), toolResult("a", "ok"), result("error_max_turns", { num_turns: 15 })),
    );
    expect(classify({ verdict: "agent_error" }, grade(), t)).toEqual([
      { code: FailureCode.F5, evidence: ["hit turn cap after 15 turns"] },
    ]);
  });

  test("F5 fires when the run was killed and has no result event", () => {
    msg = 0;
    const t = parseTranscript(jsonl(assistant(call("a", "Bash", { command: "bun test" })), toolResult("a", "ok")));
    expect(classify({ verdict: "agent_error" }, null, t)).toEqual([
      { code: FailureCode.F5, evidence: ["no result event: the run was killed (timeout)"] },
    ]);
  });

  test("F5 fires on a loop of three or more identical tool calls", () => {
    msg = 0;
    const same = { command: "bun test test/x.test.ts" };
    const t = parseTranscript(
      jsonl(
        assistant(call("a", "Bash", same)),
        assistant(call("b", "Bash", same)),
        assistant(call("c", "Bash", same)),
        result("success"),
      ),
    );
    expect(classify(failed, grade({ hiddenPass: false }), t)).toEqual([
      { code: FailureCode.F5, evidence: ["repeated Bash 3x from turn 1 to turn 3"] },
    ]);
  });

  test("F6 fires for an install that failed before any edit, and excludes the task", () => {
    msg = 0;
    const t = parseTranscript(
      jsonl(
        assistant(call("a", "Bash", { command: "bun install" })),
        toolResult("a", "error: GET https://registry.invalid/pkg - 404 Not Found", true),
        assistant(call("b", "Edit", { file_path: "src/x.ts" })),
        toolResult("b", "ok"),
        result("success"),
      ),
    );
    expect(classify({ verdict: "agent_error" }, grade({ suitePass: false, hiddenPass: false }), t)).toEqual([
      {
        code: FailureCode.F6,
        evidence: ["`bun install` failed at turn 1 before any edit: error: GET https://registry.invalid/pkg - 404 Not Found"],
      },
    ]);
  });

  test("an install that fails after the first edit is not F6", () => {
    msg = 0;
    const t = parseTranscript(
      jsonl(
        assistant(call("a", "Edit", { file_path: "src/x.ts" })),
        toolResult("a", "ok"),
        assistant(call("b", "Bash", { command: "bun install" })),
        toolResult("b", "error: boom", true),
        result("success"),
      ),
    );
    expect(classify(failed, grade({ hiddenPass: false }), t).map((c) => c.code)).not.toContain(FailureCode.F6);
  });

  test("F7 names the off-scope file and its turn", () => {
    msg = 0;
    const t = parseTranscript(
      jsonl(
        assistant(call("a", "Edit", { file_path: `${SANDBOX}/docs/notes.md` })),
        assistant(call("b", "Bash", { command: "bun test" })),
        result("success"),
      ),
    );
    const g = grade({ violations: [{ code: FailureCode.F7, path: "docs/notes.md", detail: "edit outside touched directories" }] });
    expect(classify(failed, g, t)).toEqual([
      { code: FailureCode.F7, evidence: ["edited docs/notes.md at turn 1 (edit outside touched directories)"] },
    ]);
  });
});
