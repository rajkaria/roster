import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { providerErrorOf } from "../src/harness/claude.ts";
import type { runClaude } from "../src/harness/claude.ts";
import type { HarnessResult, HarnessRunOptions } from "../src/harness/types.ts";
import { identify } from "../src/identity/index.ts";
import { parseCheckpoints } from "../src/ingest/parse.ts";
import { runReplays, type SkippedRun } from "../src/replay/run.ts";
import { planReplayTasks, type ReplayTask } from "../src/replay/tasks.ts";
import type { RunnableSetup } from "../src/setups/registry.ts";
import { FailureCode } from "../src/types.ts";
import { makeFixture } from "./fixtures/make-fixture.ts";

setDefaultTimeout(120_000);

const root = mkdtempSync(join(tmpdir(), "roster-provider-errors-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("providerErrorOf", () => {
  test("billing, auth and permission statuses", () => {
    for (const s of [401, 402, 403]) expect(providerErrorOf({ is_error: true }, "", s)).toEqual({ status: s });
  });
  test("messages without a status", () => {
    for (const m of ["Insufficient Balance", "authentication_error: bad token", "You hit the rate limit", "Overloaded"])
      expect(providerErrorOf({ is_error: true, result: m }, "", null)).toEqual({ status: null });
  });
  test("other failures are not provider errors", () => {
    expect(providerErrorOf({ is_error: true, result: "Invalid API key · Please run /login" }, "", null)).toBeNull();
    expect(providerErrorOf({ is_error: true, result: "I could not fix it" }, "", null)).toBeNull();
    expect(providerErrorOf({ is_error: true }, "", 400)).toBeNull();
  });
});

let repo: string;
let task: ReplayTask;
let rulesPath: string;
const calls: string[] = [];

const setup = (id: string, model: string): RunnableSetup => ({
  id, label: id, harness: "claude-code", model, rulesPath, extraRulesPath: null,
  env: { SOME_PROVIDER_VAR: "x" }, candidate: false,
});

beforeAll(() => {
  repo = join(root, "repo");
  makeFixture(repo, "multisession");
  const sessions = parseCheckpoints(repo, "branch", { warn: () => {} }).map((s) => ({ ...s, setup_id: identify(s, repo).setupId }));
  task = planReplayTasks(repo, sessions, []).tasks[0]!;
  rulesPath = join(root, "rules.md");
  writeFileSync(rulesPath, "rules\n");
});

// A 402 for model "deepseek-*", a finished run with no changes otherwise.
const stub: typeof runClaude = async (o: HarnessRunOptions): Promise<HarnessResult> => {
  calls.push(o.model);
  const dead = o.model.startsWith("deepseek");
  const outDir = `${o.sandboxPath}.out`;
  mkdirSync(outDir, { recursive: true });
  const transcriptPath = join(outDir, "claude.json");
  writeFileSync(
    transcriptPath,
    JSON.stringify({ type: "result", subtype: "success", is_error: dead, result: dead ? "API Error: 402 Insufficient Balance" : "Done.", api_error_status: dead ? 402 : undefined }),
  );
  return {
    harness: "claude-code", sessionId: null, model: o.model, models: [], turns: dead ? 1 : 0, durationMs: 10, costUsd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    isError: dead, errorKind: dead ? "provider_unavailable" : null, stopReason: null, transcriptPath, diff: null, setupSha: null,
    attempts: dead
      ? [{ n: 1, exitCode: 1, timedOut: false, wallMs: 10, isError: true, errorKind: "provider_unavailable", apiStatus: 402, rawPath: transcriptPath, costUsd: 0 }]
      : [],
    command: [],
  };
};

describe("provider outage in the runner", () => {
  test("402 is F6 with the status; after two, that setup's runs are skipped; other setups run", async () => {
    calls.length = 0;
    const skipped: SkippedRun[] = [];
    const tasks = [1, 2, 3, 4].map((i) => ({ ...task, id: `${task.id}-${i}` }));
    const replays = await runReplays({
      repo, tasks, workRoot: join(root, "work"), maxCostUsd: 10, parallel: 1, harness: stub, testCmd: "true",
      setups: [setup("DS", "deepseek-v4"), setup("AN", "claude-opus-5-5")],
      onSkip: (s) => skipped.push(s),
    });
    const ds = replays.filter((r) => r.setup_id === "DS");
    expect(ds).toHaveLength(2);
    for (const r of ds) {
      expect(r.verdict).toBe("agent_error");
      expect(r.failure_codes).toEqual([FailureCode.F6]);
      expect(r.error).toBe("provider_unavailable: 402");
    }
    expect(skipped.map((s) => [s.setup, s.reason])).toEqual([["DS", "provider unavailable"], ["DS", "provider unavailable"]]);
    const an = replays.filter((r) => r.setup_id === "AN");
    expect(an).toHaveLength(4);
    for (const r of an) expect(r.failure_codes).not.toContain(FailureCode.F6);
    expect(calls.filter((m) => m.startsWith("deepseek"))).toHaveLength(2);
  });
});
