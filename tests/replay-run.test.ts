import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { defaultBackend, NotAvailableError } from "../src/agent/tools.ts";
import type { runClaude } from "../src/harness/claude.ts";
import type { HarnessResult, HarnessRunOptions } from "../src/harness/types.ts";
import { identify } from "../src/identity/index.ts";
import { parseCheckpoints } from "../src/ingest/parse.ts";
import { priceSession } from "../src/price/index.ts";
import { runReplays, writeSettingSourcesShim, type SkippedRun } from "../src/replay/run.ts";
import { planReplayTasks, type ReplayTask } from "../src/replay/tasks.ts";
import type { RunnableSetup } from "../src/setups/registry.ts";
import { FailureCode } from "../src/types.ts";
import { git, makeFixture, type FixtureTruth } from "./fixtures/make-fixture.ts";

setDefaultTimeout(120_000);

// ---------- a `claude -p --output-format json` result built from the real transcript sample ----------
// Same construction as tests/harness-claude.test.ts: session id, resolved model and usage from the sample,
// cost priced from that usage with src/price.
const SAMPLE = join(import.meta.dir, "fixtures", "samples", "claude-code-full.jsonl");
const lines = readFileSync(SAMPLE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const assistant = lines.filter((l) => l.type === "assistant");
const identity = lines.find((l) => l.attachment?.identity?.modelId)?.attachment.identity.modelId as string;
const usage = assistant[0].message.usage;
const COST = priceSession(identity, {
  input: usage.input_tokens,
  output: usage.output_tokens,
  cache_read: usage.cache_read_input_tokens,
  cache_write: usage.cache_creation_input_tokens,
}).usd!;
const resultJson = {
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: assistant.length,
  result: "Done.",
  session_id: assistant[0].sessionId,
  total_cost_usd: COST,
  usage,
  stop_reason: "end_turn",
};

const root = mkdtempSync(join(tmpdir(), "roster-replay-run-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let repo: string;
let truth: FixtureTruth;
let task: ReplayTask;
let gammaSource: string;
let lastExport: string;
const workRoot = join(root, "work");

const commitOf = (subject: string) => truth.commits.find((x) => x.subject === subject)!;

// ---------- stub harness: writes a correct or a broken patch into the sandbox ----------
type Mode = "correct" | "broken" | "throw" | "timeout";
interface Seen {
  opts: HarnessRunOptions;
  claudeMd: string;
  localMd: string | null;
}

function stubHarness(mode: Mode, seen: Seen[] = []): typeof runClaude {
  return async (o: HarnessRunOptions): Promise<HarnessResult> => {
    const local = join(o.sandboxPath, "CLAUDE.local.md");
    seen.push({
      opts: o,
      claudeMd: readFileSync(join(o.sandboxPath, "CLAUDE.md"), "utf8"),
      localMd: existsSync(local) ? readFileSync(local, "utf8") : null,
    });
    if (mode === "throw") throw new Error("boom");
    const outDir = `${o.sandboxPath}.out`;
    mkdirSync(outDir, { recursive: true });
    mkdirSync(join(o.sandboxPath, "src"), { recursive: true });
    mkdirSync(join(o.sandboxPath, "tests"), { recursive: true });
    if (mode === "correct" || mode === "timeout") {
      writeFileSync(join(o.sandboxPath, "src", "gamma.ts"), gammaSource);
    } else {
      writeFileSync(join(o.sandboxPath, "src", "gamma.ts"), gammaSource.split("\n")[0] + "\n");
    }
    // The agent's own test: checks the last export, so a broken module fails the suite too.
    writeFileSync(
      join(o.sandboxPath, "tests", "gamma-agent.test.ts"),
      `import { expect, test } from "bun:test";\nimport * as g from "../src/gamma.ts";\ntest("agent", () => expect((g as Record<string, unknown>).${lastExport}).toBeDefined());\n`,
    );
    const isError = mode === "timeout";
    const transcriptPath = join(outDir, "claude.json");
    writeFileSync(transcriptPath, JSON.stringify(resultJson, null, 2));
    return {
      harness: "claude-code",
      sessionId: resultJson.session_id,
      model: identity,
      models: [identity],
      turns: resultJson.num_turns,
      durationMs: 1000,
      costUsd: COST,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      isError,
      errorKind: isError ? "timeout" : null,
      stopReason: "end_turn",
      transcriptPath,
      diff: null,
      setupSha: null,
      attempts: [],
      command: [],
    };
  };
}

let rulesPath: string;
let extraPath: string;
const setup = (over: Partial<RunnableSetup> = {}): RunnableSetup => ({
  id: "A",
  label: "A",
  harness: "claude-code",
  model: "claude-opus-5-5",
  rulesPath,
  extraRulesPath: extraPath,
  env: { SOME_PROVIDER_VAR: "x" },
  candidate: false,
  ...over,
});

beforeAll(() => {
  repo = join(root, "repo");
  truth = makeFixture(repo, "multisession");
  gammaSource = git(repo, ["show", `${commitOf("add gamma").sha}:src/gamma.ts`]) + "\n";
  lastExport = /export const (\w+)/.exec(gammaSource.trim().split("\n").at(-1)!)![1]!;
  // The team kept a test with the gamma change: a later commit that carries gamma's checkpoint.
  mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(
    join(repo, "tests", "gamma.test.ts"),
    `import { expect, test } from "bun:test";\nimport * as g from "../src/gamma.ts";\ntest("gamma", () => expect((g as Record<string, unknown>).${lastExport}).toBeDefined());\n`,
  );
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", `gamma tests\n\nEntire-Checkpoint: ${commitOf("add gamma").checkpoint_id}\n`], {
    env: { GIT_AUTHOR_DATE: "2026-10-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-01T00:00:00Z" },
  });
  const sessions = parseCheckpoints(repo, "branch", { warn: () => {} }).map((s) => ({
    ...s,
    setup_id: identify(s, repo).setupId,
  }));
  task = planReplayTasks(repo, sessions, []).tasks.find((t) => t.prompt === "Add the gamma module.")!;
  expect(task.track).toBe("tests");

  rulesPath = join(root, "rules.md");
  extraPath = join(root, "extra.md");
  writeFileSync(rulesPath, "# Replay rules\n\n- Write tests for what you build.\n");
  writeFileSync(extraPath, "- Run the full suite before you finish.\n");
});

const base = () => ({ repo, tasks: [task], workRoot, maxCostUsd: 10, testCmd: "bun test" });

describe("runReplays", () => {
  test("a correct patch passes the hidden tests; rules, model, env and setting sources reach the harness", async () => {
    const seen: Seen[] = [];
    const [r, ...rest] = await runReplays({ ...base(), setups: [setup()], harness: stubHarness("correct", seen), planId: "p1" });
    expect(rest).toEqual([]);
    expect(r!.verdict).toBe("pass");
    expect(r!.hidden_pass).toBe(true);
    expect(r!.suite_pass).toBe(true);
    expect(r!.scope_ok).toBe(true);
    expect(r!.failure_codes).toEqual([]);
    expect(r!.cost_usd).toBe(COST);
    expect(r!.plan_id).toBe("p1");
    expect(r!.task_session_id).toBe(task.id);
    expect(JSON.parse(r!.isolation_proof).ok).toBe(true);
    expect(r!.transcript_ref).toEndWith("claude.json");

    const s = seen[0]!;
    expect(s.claudeMd).toBe(readFileSync(rulesPath, "utf8"));
    expect(s.localMd).toBe(readFileSync(extraPath, "utf8"));
    expect(s.opts.model).toBe("claude-opus-5-5");
    expect(s.opts.env).toEqual({ SOME_PROVIDER_VAR: "x" });
    expect(s.opts.prompt).toBe("Add the gamma module.");
    expect(s.opts.sandboxPath.startsWith(workRoot)).toBe(true);
    expect(s.opts.bin).toBe(join(workRoot, "bin", "claude-setting-sources"));
    expect(existsSync(s.opts.sandboxPath)).toBe(false); // cleaned up
  });

  test("a broken patch fails the hidden tests with a failure code", async () => {
    const [r] = await runReplays({ ...base(), setups: [setup()], harness: stubHarness("broken") });
    expect(r!.hidden_pass).toBe(false);
    expect(r!.verdict).toBe("hidden_tests_failed");
    expect(r!.failure_codes).toContain(FailureCode.F3);
    // A result-only transcript holds no tool calls, so it is no evidence of "never ran tests".
    expect(r!.failure_codes).not.toContain(FailureCode.F2);
  });

  test("stops starting runs once the summed cost reaches maxCostUsd", async () => {
    const skipped: SkippedRun[] = [];
    const seen: Seen[] = [];
    const replays = await runReplays({
      ...base(),
      setups: [setup({ id: "A" }), setup({ id: "B" }), setup({ id: "C" })],
      maxCostUsd: COST,
      parallel: 1,
      harness: stubHarness("correct", seen),
      onSkip: (s) => skipped.push(s),
    });
    expect(replays.map((r) => r.setup_id)).toEqual(["A"]);
    expect(seen.length).toBe(1);
    expect(seen[0]!.opts.budgetUsd).toBeCloseTo(COST);
    expect(skipped.map((s) => s.setup)).toEqual(["B", "C"]);
    expect(skipped.every((s) => s.reason.startsWith("budget"))).toBe(true);
  });

  test("a candidate with empty env is skipped as unavailable", async () => {
    const skipped: SkippedRun[] = [];
    const seen: Seen[] = [];
    const replays = await runReplays({
      ...base(),
      setups: [setup({ id: "E", candidate: true, env: {} })],
      harness: stubHarness("correct", seen),
      onSkip: (s) => skipped.push(s),
    });
    expect(replays).toEqual([]);
    expect(seen).toEqual([]);
    expect(skipped).toEqual([{ task: task.id, setup: "E", reason: "unavailable" }]);
  });

  test("a harness error becomes an agent_error replay, never a throw", async () => {
    const [thrown] = await runReplays({ ...base(), setups: [setup()], harness: stubHarness("throw") });
    expect(thrown!.verdict).toBe("agent_error");
    expect(thrown!.failure_codes).toEqual([FailureCode.F6]);

    const [timedOut] = await runReplays({ ...base(), setups: [setup()], harness: stubHarness("timeout") });
    expect(timedOut!.verdict).toBe("agent_error");
    expect(timedOut!.failure_codes).toContain(FailureCode.F5);
    expect(timedOut!.cost_usd).toBe(COST);
    expect(timedOut!.hidden_pass).toBeNull();
  });

  test("runs in parallel and keeps task × setup order", async () => {
    const replays = await runReplays({
      ...base(),
      setups: [setup({ id: "A" }), setup({ id: "B" }), setup({ id: "C" }), setup({ id: "D" })],
      harness: stubHarness("correct"),
    });
    expect(replays.map((r) => r.setup_id)).toEqual(["A", "B", "C", "D"]);
    expect(replays.every((r) => r.verdict === "pass")).toBe(true);
  });

  test("refuses a work root under $HOME", async () => {
    expect(runReplays({ ...base(), workRoot: join(homedir(), "roster-replays"), setups: [setup()] })).rejects.toThrow(
      "under $HOME",
    );
  });
});

describe("setting-sources shim", () => {
  test("rewrites --setting-sources project to project,local and passes the rest through", () => {
    const dir = join(root, "shim");
    mkdirSync(dir, { recursive: true });
    const echo = join(dir, "echo-args");
    writeFileSync(echo, `#!/bin/bash\nprintf '%s\\n' "$@"\n`);
    chmodSync(echo, 0o755);
    const shim = writeSettingSourcesShim(dir, echo);
    const r = Bun.spawnSync([shim, "-p", "fix it's bug", "--setting-sources", "project", "--strict-mcp-config"]);
    expect(r.stdout.toString().split("\n").filter(Boolean)).toEqual([
      "-p",
      "fix it's bug",
      "--setting-sources",
      "project,local",
      "--strict-mcp-config",
    ]);
  });
});

describe("coordinator wiring", () => {
  test("the default backend's runReplays replays instead of throwing NotAvailableError", async () => {
    const setupsRoot = join(root, "roster");
    mkdirSync(join(setupsRoot, "setups", "rules"), { recursive: true });
    writeFileSync(join(setupsRoot, "setups", "rules", "default.md"), readFileSync(rulesPath, "utf8"));
    writeFileSync(
      join(setupsRoot, "setups", "A.json"),
      JSON.stringify({ id: "A", harness: "claude-code", model: "claude-opus-5-5", rules: "setups/rules/default.md" }),
    );
    const backend = defaultBackend({
      cacheDir: join(root, "cache"),
      reportsDir: join(root, "reports"),
      replay: { repo, setupsRoot, env: {}, workRoot, harness: stubHarness("correct"), testCmd: "bun test" },
    });
    let batch;
    try {
      batch = await backend.runReplays({ plan_id: "run-p1", tasks: [task.id], setups: ["A"], max_cost_usd: 5 });
    } catch (e) {
      expect(e).not.toBeInstanceOf(NotAvailableError);
      throw e;
    }
    expect(batch.replays.length).toBe(1);
    expect(batch.replays[0]!.plan_id).toBe("run-p1");
    expect(batch.replays[0]!.task_session_id).toBe(task.id);
    expect(batch.replays[0]!.verdict).toBe("pass");
    expect(batch.cost_usd).toBe(COST);
  });
});
