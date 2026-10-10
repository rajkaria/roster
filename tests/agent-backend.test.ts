import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBackend, simpleSample } from "../src/agent/backend.ts";
import { runCoordinator } from "../src/agent/coordinator.ts";
import { executeToolCall, initialState, type RunState, type TaskSummary, type ToolContext } from "../src/agent/tools.ts";
import { fakeClient, fakeToolCall, type FakeStep } from "../src/llm/client.ts";
import type { ChatRequest } from "../src/llm/types.ts";
import type { HarnessResult, HarnessRunOptions } from "../src/harness/types.ts";
import type { runClaude } from "../src/harness/claude.ts";
import { reviewSlug } from "../src/review/export.ts";
import { FailureCode } from "../src/types.ts";
import { makeFixture, type FixtureTruth } from "./fixtures/make-fixture.ts";

setDefaultTimeout(120_000);

// The T01 fixture repo (tests/fixtures/make-fixture.ts, scenario "basic"): four recorded agent sessions, each
// changing one file under src/, so every replay stays inside the directory the original change touched.
const root = mkdtempSync(join(tmpdir(), "roster-agent-backend-"));
const SAMPLE = join(import.meta.dir, "fixtures", "samples", "claude-code-full.jsonl");
const repo = join(root, "repo");
const reportsDir = join(root, "reports");
const cacheDir = join(root, "cache");
const workRoot = join(root, "work");
const dbPath = join(root, "roster.db");
const setupsRoot = join(root, "roster");
let truth: FixtureTruth;

afterAll(() => rmSync(root, { recursive: true, force: true }));

// ---------- stub harness: a `claude -p` result with no model call. Cost per model is fixed, so gate ties are decided by price. ----------
const COST: Record<string, number> = { "claude-opus-5-5": 0.02, "deepseek-flash": 0.01 };

function harnessResult(over: Partial<HarnessResult>): HarnessResult {
  return {
    harness: "claude-code",
    sessionId: "stub",
    model: "stub",
    models: [],
    turns: 3,
    durationMs: 1000,
    costUsd: 0.01,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    isError: false,
    errorKind: null,
    stopReason: "end_turn",
    transcriptPath: SAMPLE,
    diff: null,
    setupSha: null,
    attempts: [],
    command: [],
    ...over,
  };
}

/** "change" writes one file under src/ (inside every fixture change's directory); "timeout" fails the run. */
function stubHarness(outcomeFor: (model: string) => "change" | "timeout" = () => "change"): typeof runClaude {
  return async (o: HarnessRunOptions): Promise<HarnessResult> => {
    const costUsd = COST[o.model] ?? 0.01;
    if (outcomeFor(o.model) === "timeout") return harnessResult({ model: o.model, costUsd, isError: true, errorKind: "timeout" });
    mkdirSync(join(o.sandboxPath, "src"), { recursive: true });
    writeFileSync(join(o.sandboxPath, "src", `stub-${o.model}.ts`), `export const stub = ${JSON.stringify(o.model)};\n`);
    return harnessResult({ model: o.model, costUsd });
  };
}

/** Two setups in a temporary setups root: X is the incumbent, E a candidate with a provider env. */
function writeSetups(): void {
  mkdirSync(join(setupsRoot, "setups", "rules"), { recursive: true });
  mkdirSync(join(setupsRoot, "setups", "candidates"), { recursive: true });
  writeFileSync(join(setupsRoot, "setups", "rules", "default.md"), "# Rules\n\n- Write tests for what you build.\n");
  writeFileSync(
    join(setupsRoot, "setups", "X.json"),
    JSON.stringify({ id: "X", harness: "claude-code", model: "claude-opus-5-5", rules: "setups/rules/default.md" }),
  );
  writeFileSync(
    join(setupsRoot, "setups", "candidates", "E.json"),
    JSON.stringify({
      id: "E",
      harness: "claude-code",
      model: "deepseek-flash",
      rules: "setups/rules/default.md",
      env: { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: "${TEST_DEEPSEEK_TOKEN}" },
    }),
  );
}

const replayEnv = { TEST_DEEPSEEK_TOKEN: "test-token" };

/** A backend over the fixture: replays under the stub harness, `testCmd` "true" so the suite passes. */
function backend(harness: typeof runClaude = stubHarness(), dbFile: string | undefined = undefined) {
  return defaultBackend({
    cacheDir,
    reportsDir,
    dbPath: dbFile,
    replay: { repo, setupsRoot, env: replayEnv, workRoot, harness, testCmd: "true", parallel: 2 },
  });
}

const ctxFor = (over: Partial<ToolContext> = {}): ToolContext => ({
  runId: "run-t48",
  repo,
  budgetUsd: 10,
  spentUsd: () => 0,
  ...over,
});

beforeAll(() => {
  truth = makeFixture(repo, "basic");
  writeSetups();
});

describe("list_tasks", () => {
  test("names the replayable tasks of the fixture, by session id", async () => {
    const out = JSON.parse((await executeToolCall(fakeToolCall("list_tasks"), initialState(), ctxFor(), backend())).content);
    expect(out.ok).toBe(true);
    const tasks: TaskSummary[] = out.result.tasks;
    expect(out.result.count).toBe(tasks.length);
    expect(tasks.length).toBeGreaterThan(0);
    const sessionIds = new Set(truth.checkpoints.flatMap((c) => c.sessions.map((s) => s.session_id)));
    for (const t of tasks) {
      expect(sessionIds.has(t.id)).toBe(true);
      expect(["tests", "judge-only", "none"]).toContain(t.track);
      expect(typeof t.userPrompts).toBe("number");
      expect(t.tercile === null || [1, 2, 3].includes(t.tercile)).toBe(true);
    }
  });

  test("filters by setup, using the ids the scorecard uses (identity-derived, not the setup file ids)", async () => {
    const all: TaskSummary[] = JSON.parse((await executeToolCall(fakeToolCall("list_tasks"), initialState(), ctxFor(), backend())).content).result.tasks;
    const setup = all[0]!.setup!;
    const some = JSON.parse(
      (await executeToolCall(fakeToolCall("list_tasks", { setup }), initialState(), ctxFor(), backend())).content,
    ).result.tasks as TaskSummary[];
    expect(some.length).toBeGreaterThan(0);
    expect(some.every((t) => t.setup === setup)).toBe(true);
    expect(some.length).toBeLessThanOrEqual(all.length);
  });
});

describe("simple sampler", () => {
  const task = (id: string, track: TaskSummary["track"], tercile: TaskSummary["tercile"]): TaskSummary => ({
    id,
    setup: "X",
    track,
    tercile,
    userPrompts: 1,
    originalTurns: null,
  });
  const pool: TaskSummary[] = [
    task("t1", "tests", 1),
    task("t2", "tests", 1),
    task("t3", "tests", 2),
    task("t4", "tests", 3),
    task("t5", "judge-only", 1),
    task("t6", "none", 2),
  ];

  test("takes the tests track first, spreads across terciles, and never takes the none track", () => {
    const picked = simpleSample(pool, 3, [], "seed");
    expect(picked.length).toBe(3);
    expect(picked.every((id) => id !== "t6" && id !== "t5")).toBe(true);
    const terciles = new Set(picked.map((id) => pool.find((t) => t.id === id)!.tercile));
    expect(terciles.size).toBe(3);
    expect(simpleSample(pool, 10, [], "seed")).not.toContain("t6");
  });

  test("is deterministic for a seed and honours exclusions and the maximum", () => {
    expect(simpleSample(pool, 2, [], "seed")).toEqual(simpleSample(pool, 2, [], "seed"));
    const picked = simpleSample(pool, 10, ["t1", "t4"], "seed");
    expect(picked).not.toContain("t1");
    expect(picked).not.toContain("t4");
    expect(simpleSample(pool, 0, [], "seed")).toEqual([]);
  });

  test("plan_replays without task ids samples from the backend and labels it simple sampler", async () => {
    const state = initialState();
    const plan = await executeToolCall(
      fakeToolCall("plan_replays", { rationale: "sampled", candidates: ["E"], suspect: "X" }),
      state,
      ctxFor(),
      backend(),
    );
    const body = JSON.parse(plan.content);
    expect(body.ok).toBe(true);
    expect(body.result.sampled_by).toBe("simple sampler");
    const listed = (
      JSON.parse((await executeToolCall(fakeToolCall("list_tasks"), initialState(), ctxFor(), backend())).content).result.tasks as TaskSummary[]
    ).map((t) => t.id);
    expect(body.result.body.tasks.length).toBeGreaterThan(0);
    for (const id of body.result.body.tasks as string[]) expect(listed).toContain(id);
  });
});

describe("scripted coordinator run on the fixture", () => {
  test("list_tasks → plan_replays → run_replays → get_replay_results → gate → promote writes promotion.json", async () => {
    const lastResult = (req: ChatRequest) => {
      const m = req.messages.filter((x) => x.role === "tool").at(-1) as { content: string };
      return JSON.parse(m.content).result;
    };
    const steps: FakeStep[] = [
      { toolCalls: [fakeToolCall("list_tasks", {})], costUsd: 0 },
      (req): FakeStep => {
        const ids = (lastResult(req).tasks as TaskSummary[]).slice(0, 2).map((t) => t.id);
        return {
          toolCalls: [fakeToolCall("plan_replays", { rationale: "two listed tasks under the incumbent and E", suspect: "X", candidates: ["E"], tasks: ids })],
          costUsd: 0,
        };
      },
      { toolCalls: [fakeToolCall("run_replays", { setups: ["X", "E"] })], costUsd: 0 },
      { toolCalls: [fakeToolCall("get_replay_results", { setup: "E" })], costUsd: 0 },
      { toolCalls: [fakeToolCall("gate", { candidate: "E" })], costUsd: 0 },
      { toolCalls: [fakeToolCall("promote", { candidate: "E" })], costUsd: 0 },
      { toolCalls: [fakeToolCall("finish", { outcome: "promoted", summary: "The gate approved E; promoted." })], costUsd: 0 },
    ];
    const llm = fakeClient(steps);
    const outDir = join(root, "run-out");
    const res = await runCoordinator({
      repo,
      budgetUsd: 10,
      llm,
      backend: backend(stubHarness(), dbPath),
      outDir,
      dbPath,
      runId: "run-t48",
    });

    expect(res.outcome).toBe("promoted");
    expect(res.promoted).toBe("E");
    expect(res.decisions.map((d) => [d.candidate, d.verdict])).toEqual([["E", "promote"]]);

    // The replay rows the model read came back from the tools, filtered to E as it asked.
    const toolReplies = llm.requests.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => JSON.parse((m as { content: string }).content));
    const replayRows = toolReplies[3]!.result as { setup_id: string }[];
    expect(replayRows.length).toBeGreaterThan(0);
    expect(replayRows.every((r) => r.setup_id === "E")).toBe(true);

    const promotion = JSON.parse(readFileSync(join(reportsDir, reviewSlug(repo), "promotion.json"), "utf8"));
    expect(promotion.promoted).toBe("E");
    expect(promotion.from).toBe("X");
    expect(Array.isArray(promotion.reasons)).toBe(true);
    expect(typeof promotion.at).toBe("string");
  });
});

describe("replay rows, failures and reruns", () => {
  test("classify_failures runs the taxonomy over the failed replays' transcripts", async () => {
    const b = backend(stubHarness((model) => (model === "claude-opus-5-5" ? "timeout" : "change")));
    const state: RunState = initialState();
    const tasks = (JSON.parse((await executeToolCall(fakeToolCall("list_tasks"), state, ctxFor(), b)).content).result.tasks as TaskSummary[])
      .slice(0, 1)
      .map((t) => t.id);
    await executeToolCall(fakeToolCall("plan_replays", { rationale: "r", suspect: "X", candidates: ["E"], tasks }), state, ctxFor(), b);
    const run = await executeToolCall(fakeToolCall("run_replays", { setups: ["X", "E"] }), state, ctxFor(), b);
    expect(JSON.parse(run.content).ok).toBe(true);

    const classified = await b.classifyFailures({ plan_id: "run-t48-p1", setup: "X" });
    const body = classified as { failed: number; replays: { failures: { code: string; evidence: string[] }[] }[] };
    expect(body.failed).toBe(1);
    const codes = body.replays[0]!.failures.map((f) => f.code);
    expect(codes).toContain(FailureCode.F5);
    expect(body.replays[0]!.failures.every((f) => f.evidence.length > 0)).toBe(true);

    const clean = (await b.classifyFailures({ plan_id: "run-t48-p1", setup: "E" })) as { failed: number };
    expect(clean.failed).toBe(0);
  });

  test("replay rows are kept in the state database, so a fresh backend reads them back", async () => {
    const first = backend(stubHarness(), dbPath);
    const tasks = (await first.listTasks!({ repo })).slice(0, 1).map((t) => t.id);
    const batch = await first.runReplays({ plan_id: "persist-p1", tasks, setups: ["X"], max_cost_usd: 5 });
    expect(batch.replays.length).toBe(1);

    const second = backend(stubHarness(), dbPath);
    const rows = await second.getReplayResults({ plan_id: "persist-p1" });
    expect(rows.map((r) => r.id)).toEqual(batch.replays.map((r) => r.id));
  });

  test("rerun writes the next attempt and refuses past k = 3", async () => {
    const b = backend();
    const state = initialState();
    const ctx = ctxFor();
    const task = (await b.listTasks!({ repo }))[0]!.id;
    await executeToolCall(fakeToolCall("plan_replays", { rationale: "r", suspect: "X", candidates: ["E"], tasks: [task] }), state, ctx, b);
    await executeToolCall(fakeToolCall("run_replays", { setups: ["X", "E"] }), state, ctx, b);

    const again = (await executeToolCall(fakeToolCall("rerun", { task, setup: "X" }), state, ctx, b)).content;
    expect(JSON.parse(again).result.replays[0].attempt).toBe(2);
    const third = JSON.parse((await executeToolCall(fakeToolCall("rerun", { task, setup: "X" }), state, ctx, b)).content);
    expect(third.result.replays[0].attempt).toBe(3);
    const fourth = JSON.parse((await executeToolCall(fakeToolCall("rerun", { task, setup: "X" }), state, ctx, b)).content);
    expect(fourth.ok).toBe(false);
    expect(fourth.error).toContain("3 attempts already");

    const rows = await b.getReplayResults({ plan_id: "run-t48-p1", setup: "X" });
    expect(rows.filter((r) => r.task_session_id === task).map((r) => r.attempt).sort()).toEqual([1, 2, 3]);
  });

  test("rerun refuses a task or setup the plan does not name", async () => {
    const b = backend();
    const state = initialState();
    const ctx = ctxFor();
    const task = (await b.listTasks!({ repo }))[0]!.id;
    await executeToolCall(fakeToolCall("plan_replays", { rationale: "r", suspect: "X", candidates: ["E"], tasks: [task] }), state, ctx, b);
    const offPlan = JSON.parse((await executeToolCall(fakeToolCall("rerun", { task, setup: "Z" }), state, ctx, b)).content);
    expect(offPlan.ok).toBe(false);
    expect(offPlan.error).toContain("is not in the current plan");
  });
});

describe("revert", () => {
  test("records the revert in promotion.json", async () => {
    const b = backend();
    const reverted = (await b.revert!({ repo, setup: "E", reason: "regressed in production" })) as { promoted: null; from: string };
    expect(reverted.promoted).toBeNull();
    const doc = JSON.parse(readFileSync(join(reportsDir, reviewSlug(repo), "promotion.json"), "utf8"));
    expect(doc.promoted).toBeNull();
    expect(doc.from).toBe("E");
    expect(doc.reasons).toEqual(["regressed in production"]);
  });
});
