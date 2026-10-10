import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeClient, fakeToolCall, type FakeStep } from "../src/llm/client.ts";
import type { ChatRequest } from "../src/llm/types.ts";
import { MAX_TURNS, runCoordinator, SYSTEM_PROMPT, type CoordinatorOptions } from "../src/agent/coordinator.ts";
import { checkPlan, MAX_CANDIDATES, MAX_TASKS } from "../src/agent/plan.ts";
import {
  defaultBackend,
  executeToolCall,
  initialState,
  TOOL_SPECS,
  type ToolBackend,
  type ToolContext,
  validateArgs,
} from "../src/agent/tools.ts";
import { parseRunArgs } from "../src/cli/run.ts";
import { FailureCode, type Replay } from "../src/types.ts";

// An in-memory stand-in for the replay, grade and gate modules (not built yet). The coordinator only sees what
// these return, so the tests can script a reject → next candidate → promote run.
interface FakeBackendOpts {
  /** Gate verdict per candidate. */
  verdicts?: Record<string, "promote" | "reject">;
  /** Cost of each run_replays call. */
  replayCost?: number;
  /** Tasks whose replays come back F6. */
  f6Tasks?: string[];
}

function fakeBackend(opts: FakeBackendOpts = {}) {
  const calls: Record<string, unknown[]> = {};
  const rows: Replay[] = [];
  const note = (name: string, a: unknown) => (calls[name] ??= []).push(a);
  const row = (plan_id: string, task: string, setup: string): Replay => {
    const f6 = opts.f6Tasks?.includes(task) ?? false;
    return {
      id: `${plan_id}:${task}:${setup}`,
      plan_id,
      task_session_id: task,
      setup_id: setup,
      attempt: 1,
      isolation_proof: "test",
      turns: 3,
      duration_ms: 1000,
      cost_usd: 0,
      hidden_pass: !f6,
      suite_pass: !f6,
      scope_ok: true,
      judge_equiv: null,
      failure_codes: f6 ? [FailureCode.F6] : [],
      verdict: f6 ? "agent_error" : "pass",
      transcript_ref: null,
      trace_url: null,
    };
  };
  const backend: ToolBackend = {
    async ingestRepo(a) {
      note("ingestRepo", a);
      return { sessions: 3 };
    },
    async getScorecard(a) {
      note("getScorecard", a);
      return { review: { label: "suspect", suspect: "X" } };
    },
    async sampleTasks(a) {
      note("sampleTasks", a);
      return ["t1", "t2", "t3", "t4"].filter((t) => !a.exclude.includes(t));
    },
    async runReplays(a) {
      note("runReplays", a);
      const replays = a.tasks.flatMap((t) => a.setups.map((s) => row(a.plan_id, t, s)));
      rows.push(...replays);
      return { replays, cost_usd: opts.replayCost ?? 0 };
    },
    async getReplayResults(a) {
      note("getReplayResults", a);
      return rows.filter((r) => r.plan_id === a.plan_id && (!a.setup || r.setup_id === a.setup));
    },
    async rerun(a) {
      note("rerun", a);
      return { replays: [row(a.plan_id, a.task, a.setup)], cost_usd: 0 };
    },
    async classifyFailures(a) {
      note("classifyFailures", a);
      return {};
    },
    async gate(a) {
      note("gate", a);
      const verdict = opts.verdicts?.[a.candidate] ?? "reject";
      return {
        id: `${a.plan_id}:${a.candidate}`,
        plan_id: a.plan_id,
        candidate: a.candidate,
        verdict,
        reasons: verdict === "reject" ? ["1 regression vs incumbent"] : [],
        failed_tasks: verdict === "reject" ? ["t2"] : [],
        trace_url: null,
      };
    },
    async promote(a) {
      note("promote", a);
      return { promoted: a.candidate };
    },
    async revert(a) {
      note("revert", a);
      return { reverted: a.setup };
    },
  };
  return { backend, calls };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "roster-agent-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const opts = (over: Partial<CoordinatorOptions> & Pick<CoordinatorOptions, "llm" | "backend">): CoordinatorOptions => ({
  repo: "rajkaria/roster",
  budgetUsd: 10,
  outDir: join(dir, "out"),
  dbPath: join(dir, "roster.db"),
  runId: "run-test",
  ...over,
});

const call = fakeToolCall;
const tool = (name: string, args: Record<string, unknown> | string = {}, costUsd = 0.01): FakeStep => ({
  toolCalls: [call(name, args)],
  costUsd,
});

/** Parsed tool replies in the latest request, keyed by the order they appear. */
function toolReplies(req: ChatRequest): { ok: boolean; error?: string; result?: unknown }[] {
  return req.messages.filter((m) => m.role === "tool").map((m) => JSON.parse((m as { content: string }).content));
}
const lastReply = (req: ChatRequest) => toolReplies(req).at(-1)!;

describe("coordinator: reject → next candidate → promote", () => {
  test("completes, writes plan.json, decisions.json and the db rows", async () => {
    const { backend, calls } = fakeBackend({ verdicts: { E: "reject", F: "promote" } });
    let sawRejectNote = false;
    const llm = fakeClient([
      tool("get_scorecard"),
      tool("plan_replays", {
        rationale: "X is the level-A suspect; replay three tasks across terciles under E and F.",
        suspect: "X",
        candidates: ["E", "F"],
        tasks: ["t1", "t2", "t3"],
      }),
      tool("run_replays", { setups: ["X", "E", "F"] }),
      tool("gate", { candidate: "E" }),
      (req) => {
        const last = req.messages.at(-1)!;
        sawRejectNote = last.role === "user" && last.content.includes("The gate rejected E");
        return tool("plan_replays", {
          rationale: "E regressed on t2; F is next.",
          suspect: "X",
          candidates: ["F"],
          tasks: ["t1", "t2", "t3"],
          reason: "gate rejected E",
        });
      },
      tool("gate", { candidate: "F" }),
      tool("promote", { candidate: "F" }),
    ]);

    const res = await runCoordinator(opts({ llm, backend }));
    expect(res.outcome).toBe("promoted");
    expect(res.promoted).toBe("F");
    expect(res.turns).toBe(7);
    expect(res.llmUsd).toBeCloseTo(0.07);
    expect(sawRejectNote).toBe(true);
    expect(calls.promote).toHaveLength(1);
    expect(llm.requests[0]!.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(SYSTEM_PROMPT).toContain(
      "You decide what to try next. The gate decides what ships. Never claim a result the tools didn't return.",
    );
    expect(llm.requests[0]!.tools!.map((t) => t.name)).toEqual(TOOL_SPECS.map((t) => t.name));

    const plan = JSON.parse(readFileSync(join(dir, "out", "plan.json"), "utf8"));
    expect(plan.candidates).toEqual(["F"]);
    expect(plan.tasks).toEqual(["t1", "t2", "t3"]);
    expect(plan.rationale).toBe("E regressed on t2; F is next.");
    expect(plan.budget_usd).toBe(10);
    expect(plan.revision).toBe(2);
    expect(plan.iteration).toBe(1); // F was already in the first candidate set
    expect(plan.history.map((h: { reason: string }) => h.reason)).toEqual(["initial", "gate rejected E"]);
    expect(plan.stop_rules.length).toBeGreaterThan(0);

    const decisions = JSON.parse(readFileSync(join(dir, "out", "decisions.json"), "utf8"));
    expect(decisions.outcome).toBe("promoted");
    expect(decisions.decisions.map((d: { candidate: string; verdict: string }) => [d.candidate, d.verdict])).toEqual([
      ["E", "reject"],
      ["F", "promote"],
    ]);
    expect(decisions.decisions[0].failed_tasks).toEqual(["t2"]);
    expect(decisions.decisions[0].reasons).toEqual(["1 regression vs incumbent"]);

    const db = new Database(join(dir, "roster.db"), { readonly: true });
    expect(db.query("SELECT candidate, verdict FROM gate_decisions ORDER BY candidate").all()).toEqual([
      { candidate: "E", verdict: "reject" },
      { candidate: "F", verdict: "promote" },
    ]);
    expect(db.query("SELECT id FROM plans ORDER BY id").all()).toEqual([{ id: "run-test-p1" }, { id: "run-test-p2" }]);
    const kinds = db.query<{ kind: string }, []>("SELECT kind FROM events WHERE run_id = 'run-test' ORDER BY seq").all();
    expect(kinds[0]!.kind).toBe("start");
    expect(kinds.at(-1)!.kind).toBe("end");
    db.close();
  });

  test("promote refuses a candidate the gate did not approve", async () => {
    const { backend, calls } = fakeBackend({ verdicts: { E: "reject" } });
    const llm = fakeClient([
      tool("promote", { candidate: "E" }),
      tool("plan_replays", { rationale: "r", candidates: ["E"], tasks: ["t1"] }),
      tool("promote", { candidate: "E" }),
      tool("gate", { candidate: "E" }),
      tool("promote", { candidate: "E" }),
      (req) => {
        expect(lastReply(req).error).toContain("the gate has not approved E");
        return tool("finish", { outcome: "promoted", summary: "E is better" });
      },
      (req) => {
        expect(lastReply(req).error).toContain("nothing was promoted");
        return tool("finish", { outcome: "no_better_setup", summary: "the gate rejected E" });
      },
    ]);
    const res = await runCoordinator(opts({ llm, backend }));
    expect(toolReplies(llm.requests[1]!)[0]!.error).toContain("no plan yet");
    expect(toolReplies(llm.requests[3]!)[2]!.error).toContain("the gate has not approved E");
    expect(calls.promote).toBeUndefined();
    expect(res.outcome).toBe("no_better_setup");
    expect(res.promoted).toBeNull();
    expect(res.summary).toBe("the gate rejected E");
  });

  test("a rejected candidate cannot be planned again, and a third candidate set exceeds the iteration limit", async () => {
    const { backend } = fakeBackend({ verdicts: { E: "reject", F: "reject" } });
    const llm = fakeClient([
      tool("plan_replays", { rationale: "r", candidates: ["E"], tasks: ["t1"] }),
      tool("gate", { candidate: "E" }),
      tool("plan_replays", { rationale: "r", candidates: ["E"], tasks: ["t1"] }),
      tool("plan_replays", { rationale: "r", candidates: ["F"], tasks: ["t1"] }),
      tool("gate", { candidate: "F" }),
      tool("plan_replays", { rationale: "r", candidates: ["G"], tasks: ["t1"] }),
      tool("finish", { outcome: "no_better_setup", summary: "E and F were rejected" }),
    ]);
    const res = await runCoordinator(opts({ llm, backend }));
    expect(lastReply(llm.requests[3]!).error).toContain("the gate already rejected E");
    expect(lastReply(llm.requests[4]!).ok).toBe(true);
    expect(lastReply(llm.requests[6]!).error).toContain("iterations: at most 2");
    expect(res.outcome).toBe("no_better_setup");
    const plan = JSON.parse(readFileSync(join(dir, "out", "plan.json"), "utf8"));
    expect(plan.iteration).toBe(2);
    expect(plan.candidates).toEqual(["F"]);
  });
});

describe("coordinator: budget", () => {
  test("hard-stops on LLM spend", async () => {
    const { backend } = fakeBackend();
    const llm = fakeClient(Array.from({ length: 10 }, () => tool("get_scorecard", {}, 0.4)));
    const res = await runCoordinator(opts({ llm, backend, budgetUsd: 1 }));
    expect(res.outcome).toBe("budget");
    expect(res.turns).toBe(3);
    expect(llm.requests).toHaveLength(3);
    expect(res.spentUsd).toBeCloseTo(1.2);
    expect(JSON.parse(readFileSync(res.decisionsPath, "utf8")).outcome).toBe("budget");
  });

  test("counts replay cost, caps replays at the remaining budget, and stops before the next call", async () => {
    const { backend, calls } = fakeBackend({ replayCost: 5 });
    const llm = fakeClient([
      tool("plan_replays", { rationale: "r", candidates: ["E"], tasks: ["t1", "t2"] }, 0.5),
      tool("run_replays", { setups: ["X", "E"] }, 0.5),
      tool("gate", { candidate: "E" }),
    ]);
    const res = await runCoordinator(opts({ llm, backend, budgetUsd: 3 }));
    expect((calls.runReplays![0] as { max_cost_usd: number }).max_cost_usd).toBeCloseTo(2);
    expect(res.outcome).toBe("budget");
    expect(res.replayUsd).toBe(5);
    expect(res.llmUsd).toBeCloseTo(1);
    expect(llm.requests).toHaveLength(2);
    expect(calls.gate).toBeUndefined();
  });

  test("an unpriced LLM call is counted as unpriced, not as free spend silently", async () => {
    const { backend } = fakeBackend();
    const llm = fakeClient([
      { ...(tool("get_scorecard") as object), costUsd: null },
      tool("finish", { outcome: "no_better_setup", summary: "s" }),
    ]);
    const res = await runCoordinator(opts({ llm, backend }));
    expect(res.unpricedLlmCalls).toBe(1);
    expect(JSON.parse(readFileSync(res.decisionsPath, "utf8")).spent.unpriced_llm_calls).toBe(1);
  });
});

describe("coordinator: malformed tool calls", () => {
  test("are answered with an error message and the run continues", async () => {
    const { backend, calls } = fakeBackend();
    const llm = fakeClient([
      tool("gate", "{not json"),
      tool("no_such_tool", {}),
      tool("gate", {}),
      tool("gate", { candidate: 7 }),
      tool("plan_replays", { rationale: "r", candidates: ["E"], tasks: ["t1"], bogus: true }),
      tool("plan_replays", { rationale: "r", candidates: ["A", "B", "C", "D"], tasks: ["t1"] }),
      tool("propose_rules_candidate", { setup: "X" }),
      { toolCalls: [call("ingest_repo", "[1,2]"), call("finish", { outcome: "maybe", summary: "s" })] },
      tool("finish", { outcome: "no_better_setup", summary: "nothing ran" }),
    ]);
    const res = await runCoordinator(opts({ llm, backend }));
    expect(res.outcome).toBe("no_better_setup");
    const errors = toolReplies(llm.requests.at(-1)!).map((r) => r.error);
    expect(errors[0]).toContain("not valid JSON");
    expect(errors[1]).toContain('unknown tool "no_such_tool"');
    expect(errors[2]).toContain('missing required argument "candidate"');
    expect(errors[3]).toContain('argument "candidate" must be string');
    expect(errors[4]).toContain('unknown argument "bogus"');
    expect(errors[5]).toContain(`at most ${MAX_CANDIDATES} per iteration`);
    expect(errors[6]).toBe("not available yet: propose_rules_candidate (src/candidates is not built)");
    expect(errors[7]).toContain("must be a JSON object");
    expect(errors[8]).toContain("must be one of promoted, no_better_setup");
    expect(calls.gate).toBeUndefined();
  });

  test("a backend that throws is reported to the model, not raised", async () => {
    const { backend } = fakeBackend();
    backend.getScorecard = async () => {
      throw new Error("disk on fire");
    };
    const llm = fakeClient([tool("get_scorecard"), tool("finish", { outcome: "no_better_setup", summary: "s" })]);
    const res = await runCoordinator(opts({ llm, backend }));
    expect(res.outcome).toBe("no_better_setup");
    expect(lastReply(llm.requests[1]!).error).toBe("get_scorecard failed: disk on fire");
  });
});

describe("coordinator: replan on F6", () => {
  test("F6 tasks are excluded and the model is asked to resample", async () => {
    const { backend } = fakeBackend({ f6Tasks: ["t2"], verdicts: { E: "promote" } });
    let note = "";
    const llm = fakeClient([
      tool("plan_replays", { rationale: "r", candidates: ["E"], tasks: ["t1", "t2"] }),
      tool("run_replays", { setups: ["X", "E"] }),
      (req) => {
        const last = req.messages.at(-1)!;
        note = last.role === "user" ? last.content : "";
        return tool("plan_replays", { rationale: "resample", candidates: ["E"], tasks: ["t1", "t2"] });
      },
      tool("plan_replays", { rationale: "resample", candidates: ["E"], reason: "F6 on t2" }),
      tool("gate", { candidate: "E" }),
      tool("promote", { candidate: "E" }),
    ]);
    const res = await runCoordinator(opts({ llm, backend }));
    expect(note).toContain("F6");
    expect(note).toContain("t2");
    expect(lastReply(llm.requests[3]!).error).toContain("t2 hit F6 and are excluded");
    expect(res.outcome).toBe("promoted");
    const plan = JSON.parse(readFileSync(join(dir, "out", "plan.json"), "utf8"));
    expect(plan.tasks).toEqual(["t1", "t3", "t4"]);
    const decisions = JSON.parse(readFileSync(res.decisionsPath, "utf8"));
    expect(decisions.excluded_tasks).toEqual(["t2"]);
  });
});

describe("coordinator: stop conditions and resume", () => {
  test(`stops after ${MAX_TURNS} turns`, async () => {
    const { backend } = fakeBackend();
    const llm = fakeClient(Array.from({ length: MAX_TURNS + 5 }, () => tool("get_scorecard", {}, 0)));
    const res = await runCoordinator(opts({ llm, backend }));
    expect(res.outcome).toBe("max_turns");
    expect(res.turns).toBe(MAX_TURNS);
  });

  test("a reply without tool calls stops the run", async () => {
    const { backend } = fakeBackend();
    const res = await runCoordinator(opts({ llm: fakeClient([{ content: "done" }]), backend }));
    expect(res.outcome).toBe("stopped");
    expect(res.summary).toBe("done");
  });

  test("resumes from the events log without redoing finished steps", async () => {
    const { backend, calls } = fakeBackend({ verdicts: { E: "promote" } });
    const first = fakeClient([
      tool("get_scorecard"),
      tool("plan_replays", { rationale: "r", candidates: ["E"], tasks: ["t1"] }),
      new Error("HTTP 503 after retries"),
    ]);
    const a = await runCoordinator(opts({ llm: first, backend }));
    expect(a.outcome).toBe("llm_error");
    expect(existsSync(join(dir, "out", "plan.json"))).toBe(true);

    const second = fakeClient([tool("gate", { candidate: "E" }), tool("promote", { candidate: "E" })]);
    const b = await runCoordinator(opts({ llm: second, backend }));
    expect(b.resumed).toBe(true);
    expect(b.outcome).toBe("promoted");
    expect(b.turns).toBe(4);
    expect(b.llmUsd).toBeCloseTo(0.04);
    expect(calls.getScorecard).toHaveLength(1);
    // The resumed conversation carries the earlier turns.
    expect(toolReplies(second.requests[0]!)).toHaveLength(2);

    const third = fakeClient([]);
    const c = await runCoordinator(opts({ llm: third, backend }));
    expect(c.outcome).toBe("promoted");
    expect(c.resumed).toBe(true);
    expect(third.requests).toHaveLength(0);
  });

  test("resume answers tool calls the crashed run never answered", async () => {
    const { backend, calls } = fakeBackend();
    const db = join(dir, "roster.db");
    // A crash between the model's reply and the tool's answer leaves an `llm` event with an unanswered call.
    const first = fakeClient([tool("get_scorecard"), new Error("crash")]);
    await runCoordinator(opts({ llm: first, backend }));
    const h = new Database(db);
    h.query("DELETE FROM events WHERE run_id = 'run-test' AND kind IN ('tool', 'end')").run();
    h.close();
    const second = fakeClient([tool("finish", { outcome: "no_better_setup", summary: "s" })]);
    const res = await runCoordinator(opts({ llm: second, backend }));
    expect(res.outcome).toBe("no_better_setup");
    expect(calls.getScorecard).toHaveLength(2);
    expect(toolReplies(second.requests[0]!)).toHaveLength(1);
  });
});

describe("plan limits", () => {
  const ctx = { budgetUsd: 5, previous: [], excludedTasks: new Set<string>(), rejected: new Set<string>(), reason: "initial" };
  test("caps tasks, requires a rationale, and never raises the budget", () => {
    const tasks = Array.from({ length: MAX_TASKS + 1 }, (_, i) => `t${i}`);
    const bad = checkPlan({ rationale: " ", candidates: ["E"], tasks }, ctx);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.some((e) => e.startsWith("rationale"))).toBe(true);
      expect(bad.errors.some((e) => e.includes(`at most ${MAX_TASKS}`))).toBe(true);
    }
    const ok = checkPlan({ rationale: "r", candidates: ["E"], tasks: ["t1"], budget_usd: 50 }, ctx);
    expect(ok.ok && ok.revision.body.budget_usd).toBe(5);
  });
});

describe("roster run arguments", () => {
  test("requires a repo and a positive budget", () => {
    expect(parseRunArgs(["repo", "--budget", "2.5", "--run-id=r1"])).toMatchObject({ repo: "repo", budgetUsd: 2.5, runId: "r1" });
    expect(() => parseRunArgs(["repo"])).toThrow("--budget is required");
    expect(() => parseRunArgs(["repo", "--budget", "0"])).toThrow("positive number");
    expect(() => parseRunArgs(["--budget", "1"])).toThrow("missing <repo>");
    expect(() => parseRunArgs(["repo", "--budget", "1", "--nope"])).toThrow("unknown flag");
  });
});

describe("tools", () => {
  test("validateArgs accepts nullable suspect and rejects non-string arrays", () => {
    const spec = TOOL_SPECS.find((t) => t.name === "plan_replays")!;
    expect(validateArgs(spec, { rationale: "r", candidates: ["E"], suspect: null })).toEqual([]);
    expect(validateArgs(spec, { rationale: "r", candidates: [1] })).toEqual(['argument "candidates" must be array of string']);
  });

  test("the default backend reports unbuilt modules as not available", async () => {
    const ctx: ToolContext = { runId: "r", repo: "x", budgetUsd: 1, spentUsd: () => 0 };
    const state = initialState();
    const backend = defaultBackend({ reportsDir: join(dir, "reports") });
    const plan = await executeToolCall(call("plan_replays", { rationale: "r", candidates: ["E"] }), state, ctx, backend);
    expect(JSON.parse(plan.content).error).toContain("not available yet");
    const score = await executeToolCall(call("get_scorecard"), state, ctx, backend);
    expect(JSON.parse(score.content).error).toContain("no review for x");
  });
});
