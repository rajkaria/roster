import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaude } from "../src/harness/claude.ts";
import type { HarnessRunOptions } from "../src/harness/types.ts";
import { priceDeepSeek } from "../src/price/deepseek.ts";
import { createSandbox } from "../src/sandbox/index.ts";

// Stub `claude` printing a canned result. Shape follows the G4 replay: setup E, deepseek-flash, 53 turns,
// reported cost 2.010872 (Claude prices), error "budget".
const STUB = `#!/bin/bash
d="$STUB_DIR"
printf '%s\\n' "$@" > "$d/args"
cat "$d/resp.json"
`;
const REPORTED = 2.010872;
const TOKENS = { input: 400_000, output: 60_000, cache_read: 3_000_000 };
const NOW = new Date("2026-10-10T12:00:00Z"); // Saturday: off-peak

function resultJson(over: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 53,
    result: "Done.",
    session_id: "s-1",
    total_cost_usd: REPORTED,
    modelUsage: {
      "deepseek-flash": {
        inputTokens: TOKENS.input,
        outputTokens: TOKENS.output,
        cacheReadInputTokens: TOKENS.cache_read,
        cacheCreationInputTokens: 0,
        costUSD: REPORTED,
      },
    },
    ...over,
  };
}

let tmp: string;
let source: string;
let binDir: string;
let stubDir: string;
let rules: string;
let n = 0;

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "F", GIT_AUTHOR_EMAIL: "f@x.invalid", GIT_COMMITTER_NAME: "F", GIT_COMMITTER_EMAIL: "f@x.invalid" },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "roster-provider-cost-"));
  source = join(tmp, "source");
  mkdirSync(source);
  git(source, "init", "-q");
  writeFileSync(join(source, "app.txt"), "base\n");
  git(source, "add", "-A");
  git(source, "commit", "-qm", "base");
  binDir = join(tmp, "bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "claude"), STUB);
  chmodSync(join(binDir, "claude"), 0o755);
  rules = join(tmp, "rules.md");
  writeFileSync(rules, "# rules\n");
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => {
  stubDir = join(tmp, `stub-${++n}`);
  mkdirSync(stubDir);
  setSystemTime(NOW);
});
afterEach(() => setSystemTime());

async function opts(env: Record<string, string>, over: Partial<HarnessRunOptions> = {}): Promise<HarnessRunOptions> {
  const sb = await createSandbox(source, git(source, "rev-parse", "HEAD"), { root: join(tmp, "sandboxes") });
  return {
    sandboxPath: sb.path,
    prompt: "task",
    model: "deepseek-flash",
    rulesFile: rules,
    maxTurns: 30,
    timeoutMs: 10_000,
    budgetUsd: 2,
    retryBaseMs: 1,
    env: { PATH: `${binDir}:${process.env.PATH}`, STUB_DIR: stubDir, ...env },
    ...over,
  };
}
const put = (v: unknown) => writeFileSync(join(stubDir, "resp.json"), JSON.stringify(v));
const argv = () => readFileSync(join(stubDir, "args"), "utf8").split("\n").slice(0, -1);
const expected = () => priceDeepSeek("deepseek-flash", TOKENS, NOW)!.usd!;

const DEEPSEEK = { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic" };

describe("provider setups are priced by Roster", () => {
  test("DeepSeek: no --max-budget-usd, costUsd from tokens, reportedCostUsd kept", async () => {
    put(resultJson());
    const r = await runClaude(await opts(DEEPSEEK));
    expect(r.command).not.toContain("--max-budget-usd");
    expect(argv()).not.toContain("--max-budget-usd");
    expect(r.costUsd).toBeCloseTo(expected(), 12);
    expect(r.costUsd!).toBeLessThan(REPORTED);
    expect(r.reportedCostUsd).toBe(REPORTED);
    expect(r.isError).toBe(false);
    expect(r.attempts[0]!.costUsd).toBeCloseTo(expected(), 12);
  });

  test("DeepSeek: over the per-run budget after the run is error budget with the Roster cost", async () => {
    put(resultJson());
    const r = await runClaude(await opts(DEEPSEEK, { budgetUsd: expected() / 2 }));
    expect(r.isError).toBe(true);
    expect(r.errorKind).toBe("budget");
    expect(r.costUsd).toBeCloseTo(expected(), 12);
    expect(r.reportedCostUsd).toBe(REPORTED);
  });

  test("DeepSeek: a run under the budget is not flagged even when the reported cost exceeds it", async () => {
    put(resultJson());
    const r = await runClaude(await opts(DEEPSEEK, { budgetUsd: REPORTED - 0.01 }));
    expect(r.errorKind).toBeNull();
  });

  test("DeepSeek: an errored run keeps its own error kind", async () => {
    put(resultJson({ is_error: true, subtype: "error_max_turns" }));
    const r = await runClaude(await opts(DEEPSEEK, { budgetUsd: expected() / 2 }));
    expect(r.errorKind).toBe("max_turns");
    expect(r.costUsd).toBeCloseTo(expected(), 12);
  });

  test("DeepSeek: an unpriced model leaves costUsd null", async () => {
    put(resultJson({ modelUsage: { "mystery-model": { inputTokens: 5, outputTokens: 5 } } }));
    const r = await runClaude(await opts(DEEPSEEK, { model: "mystery-model" }));
    expect(r.costUsd).toBeNull();
    expect(r.reportedCostUsd).toBe(REPORTED);
  });

  test("Anthropic base URL or no base URL: --max-budget-usd stays and the reported cost is used", async () => {
    const envs: Record<string, string>[] = [{}, { ANTHROPIC_BASE_URL: "https://api.anthropic.com" }];
    for (const env of envs) {
      put(resultJson());
      const r = await runClaude(await opts(env, { model: "opus", budgetUsd: 0.25 }));
      const a = argv();
      expect(a[a.indexOf("--max-budget-usd") + 1]).toBe("0.25");
      expect(r.costUsd).toBe(REPORTED);
      expect(r.reportedCostUsd).toBe(REPORTED);
    }
  });
});
