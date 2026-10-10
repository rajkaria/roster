// T38: a replay whose setup rules equal the repo's own CLAUDE.md still reaches the harness, and every failure
// keeps its reason in Replay.error.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { runClaude } from "../src/harness/claude.ts";
import type { HarnessResult, HarnessRunOptions } from "../src/harness/types.ts";
import { identify } from "../src/identity/index.ts";
import { parseCheckpoints } from "../src/ingest/parse.ts";
import { runReplays } from "../src/replay/run.ts";
import { planReplayTasks, type ReplayTask } from "../src/replay/tasks.ts";
import type { RunnableSetup } from "../src/setups/registry.ts";
import { FailureCode } from "../src/types.ts";
import { git, makeFixture, type FixtureTruth } from "./fixtures/make-fixture.ts";

setDefaultTimeout(120_000);

// A `claude -p --output-format json` result built from the real transcript sample (as in tests/replay-run.test.ts).
const SAMPLE = join(import.meta.dir, "fixtures", "samples", "claude-code-full.jsonl");
const lines = readFileSync(SAMPLE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const assistant = lines.filter((l) => l.type === "assistant");
const identity = lines.find((l) => l.attachment?.identity?.modelId)?.attachment.identity.modelId as string;
const resultJson = {
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: assistant.length,
  result: "Done.",
  session_id: assistant[0].sessionId,
  usage: assistant[0].message.usage,
  stop_reason: "end_turn",
};

const root = mkdtempSync(join(tmpdir(), "roster-replay-rules-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const workRoot = join(root, "work");

let repo: string;
let truth: FixtureTruth;
let task: ReplayTask;
let gammaSource: string;
let ownRulesPath: string;

type Mode = "correct" | "throw" | "error";

function stubHarness(mode: Mode, calls: HarnessRunOptions[]): typeof runClaude {
  return async (o: HarnessRunOptions): Promise<HarnessResult> => {
    calls.push(o);
    if (mode === "throw") throw new Error("boom: spawn exploded");
    const outDir = `${o.sandboxPath}.out`;
    mkdirSync(outDir, { recursive: true });
    mkdirSync(join(o.sandboxPath, "src"), { recursive: true });
    writeFileSync(join(o.sandboxPath, "src", "gamma.ts"), gammaSource);
    const transcriptPath = join(outDir, "claude.json");
    writeFileSync(transcriptPath, JSON.stringify(resultJson));
    const isError = mode === "error";
    return {
      harness: "claude-code",
      sessionId: resultJson.session_id,
      model: identity,
      models: [identity],
      turns: resultJson.num_turns,
      durationMs: 1000,
      costUsd: 0.01,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      isError,
      errorKind: isError ? "rate_limited" : null,
      stopReason: "end_turn",
      transcriptPath,
      diff: null,
      setupSha: null,
      attempts: [],
      command: [],
    };
  };
}

const setup = (over: Partial<RunnableSetup> = {}): RunnableSetup => ({
  id: "A",
  label: "A",
  harness: "claude-code",
  model: "claude-opus-5-5",
  rulesPath: ownRulesPath,
  extraRulesPath: null,
  env: { SOME_PROVIDER_VAR: "x" },
  candidate: false,
  ...over,
});

beforeAll(() => {
  repo = join(root, "repo");
  truth = makeFixture(repo, "multisession");
  const gamma = truth.commits.find((x) => x.subject === "add gamma")!;
  gammaSource = git(repo, ["show", `${gamma.sha}:src/gamma.ts`]) + "\n";
  const sessions = parseCheckpoints(repo, "branch", { warn: () => {} }).map((s) => ({
    ...s,
    setup_id: identify(s, repo).setupId,
  }));
  task = planReplayTasks(repo, sessions, []).tasks.find((t) => t.prompt === "Add the gamma module.")!;
  // The setup's rules are byte-for-byte the CLAUDE.md the repo already has at the task's parent commit.
  ownRulesPath = join(root, "own-rules.md");
  const blob = Bun.spawnSync(["git", "-C", repo, "show", `${task.parentSha}:CLAUDE.md`]);
  expect(blob.exitCode).toBe(0);
  writeFileSync(ownRulesPath, blob.stdout);
});

const base = () => ({ repo, tasks: [task], workRoot, maxCostUsd: 10, testCmd: "bun test" });

describe("rules identical to the repo's own CLAUDE.md", () => {
  test("the harness is called and the replay grades", async () => {
    const calls: HarnessRunOptions[] = [];
    const [r] = await runReplays({ ...base(), setups: [setup()], harness: stubHarness("correct", calls) });
    expect(calls.length).toBe(1);
    expect(r!.error).toBeNull();
    expect(JSON.parse(r!.isolation_proof).ok).toBe(true);
    expect(r!.verdict).not.toBe("agent_error");
    expect(r!.suite_pass).not.toBeNull();
    expect(r!.failure_codes).not.toContain(FailureCode.F6);
  });
});

describe("Replay.error keeps the failure reason", () => {
  test("a failure before the harness records its reason", async () => {
    const calls: HarnessRunOptions[] = [];
    const missing = join(root, "no-such-rules.md");
    const [r] = await runReplays({
      ...base(),
      setups: [setup({ rulesPath: missing })],
      harness: stubHarness("correct", calls),
    });
    expect(calls.length).toBe(0);
    expect(r!.verdict).toBe("agent_error");
    expect(r!.failure_codes).toEqual([FailureCode.F6]);
    expect(r!.error).toContain("no-such-rules.md");
    // The isolation proof passed, so the reason lives only in `error`.
    expect(JSON.parse(r!.isolation_proof).ok).toBe(true);
  });

  test("a harness that throws keeps its message", async () => {
    const [r] = await runReplays({ ...base(), setups: [setup()], harness: stubHarness("throw", []) });
    expect(r!.verdict).toBe("agent_error");
    expect(r!.error).toContain("boom: spawn exploded");
  });

  test("a harness that returns isError keeps its error kind", async () => {
    const [r] = await runReplays({ ...base(), setups: [setup()], harness: stubHarness("error", []) });
    expect(r!.verdict).toBe("agent_error");
    expect(r!.error).toBe("rate_limited");
  });
});
