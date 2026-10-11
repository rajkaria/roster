import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeClient, fakeToolCall } from "../src/llm/client.ts";
import { detectionsFor, runCoordinator } from "../src/agent/coordinator.ts";
import type { ToolBackend } from "../src/agent/tools.ts";
import type { Replay } from "../src/types.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "roster-det-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const row = (plan_id: string, task: string, setup: string, over: Partial<Replay> = {}): Replay => ({
  id: `${plan_id}:${task}:${setup}`,
  plan_id,
  task_session_id: task,
  setup_id: setup,
  attempt: 1,
  isolation_proof: "test",
  turns: 3,
  duration_ms: 1000,
  cost_usd: 0.1,
  hidden_pass: true,
  suite_pass: true,
  scope_ok: true,
  judge_equiv: null,
  failure_codes: [],
  verdict: "pass",
  transcript_ref: null,
  trace_url: null,
  ...over,
});

// A scripted run: E's replay of t2 passes the visible suite but fails the hidden tests (a silent pass).
function backend(): ToolBackend {
  const rows: Replay[] = [];
  return {
    async ingestRepo() { return {}; },
    async getScorecard() { return {}; },
    async sampleTasks() { return ["t1", "t2"]; },
    async runReplays(a) {
      const replays = a.tasks.flatMap((t) =>
        a.setups.map((s) => row(a.plan_id, t, s, s === "E" && t === "t2" ? { hidden_pass: false, verdict: "hidden_tests_failed" } : {})),
      );
      rows.push(...replays);
      return { replays, cost_usd: 0 };
    },
    async getReplayResults(a) { return rows.filter((r) => r.plan_id === a.plan_id); },
    async rerun() { return { replays: [], cost_usd: 0 }; },
    async classifyFailures() { return {}; },
    async gate(a) {
      return { id: `${a.plan_id}:${a.candidate}`, plan_id: a.plan_id, candidate: a.candidate, verdict: "reject", reasons: ["x"], failed_tasks: ["t2"], trace_url: null };
    },
    async promote() { return {}; },
    async revert() { return {}; },
  } as ToolBackend;
}

describe("detections on every run", () => {
  test("a silent pass puts D1 in decisions.json", async () => {
    const llm = fakeClient([
      { toolCalls: [fakeToolCall("plan_replays", { rationale: "r", suspect: "X", candidates: ["E"], tasks: ["t1", "t2"] })], costUsd: 0.01 },
      { toolCalls: [fakeToolCall("run_replays", { setups: ["X", "E"] })], costUsd: 0.01 },
      { content: "done", costUsd: 0.01 },
    ]);
    const outDir = join(dir, "out");
    const res = await runCoordinator({ repo: "rajkaria/roster", budgetUsd: 10, outDir, dbPath: join(dir, "r.db"), runId: "run-det", llm, backend: backend() });
    const doc = JSON.parse(readFileSync(res.decisionsPath, "utf8"));
    expect(doc.detections).toEqual([
      { id: "D1", setup: "E", task: "t2", detail: "visible suite passed but hidden tests failed" },
    ]);
  });

  test("a run with no replays has an empty detections list", async () => {
    const outDir = join(dir, "out2");
    const res = await runCoordinator({
      repo: "rajkaria/roster", budgetUsd: 10, outDir, dbPath: join(dir, "r2.db"), runId: "run-none",
      llm: fakeClient([{ content: "nothing to do", costUsd: 0.01 }]), backend: backend(),
    });
    expect(JSON.parse(readFileSync(res.decisionsPath, "utf8")).detections).toEqual([]);
  });

  test("detectionsFor treats null hidden/scope as no signal, and flags D3 and D4", () => {
    const rs = [
      row("p", "t1", "X", { hidden_pass: null, scope_ok: null }),
      row("p", "t2", "X", { cost_usd: 0.1 }),
      row("p", "t2", "E", { cost_usd: 1, failure_codes: ["F6" as never] }),
      row("p", "t2", "F", { failure_codes: ["F6" as never] }),
    ];
    expect(detectionsFor(rs, "X").map((d) => d.id)).toEqual(["D3", "D4"]);
  });

  test("the review 1b script writes detections.json from the saved replays", () => {
    const p = Bun.spawnSync(["bun", "scripts/experiments/detections-review-1b.ts"]);
    expect(p.exitCode).toBe(0);
    expect(existsSync("reports/self/review-1b/detections.json")).toBe(true);
    const list = JSON.parse(readFileSync("reports/self/review-1b/detections.json", "utf8"));
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((d: { id: string }) => /^D[1-4]$/.test(d.id))).toBe(true);
  });
});
