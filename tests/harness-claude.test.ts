import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { apiStatusOf, childEnv, resolvedModel, runClaude } from "../src/harness/claude.ts";
import type { HarnessRunOptions } from "../src/harness/types.ts";
import { priceSession } from "../src/price/index.ts";
import { createSandbox } from "../src/sandbox/index.ts";

// ---------- fixture: a `claude -p --output-format json` result built from a real sample ----------
// No captured headless result exists in the repo yet (the spike never authenticated headless), so the
// envelope is built from the real Claude Code transcript sample: its session id, resolved model id and
// per-request usage. Envelope keys are the ones DESIGN.md §"Harness adapters" and the spike parser read.
// Cost is priced from that usage with src/price. Replace with a live capture once one is committed.
const SAMPLE = join(import.meta.dir, "fixtures", "samples", "claude-code-full.jsonl");
const lines = readFileSync(SAMPLE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const assistant = lines.filter((l) => l.type === "assistant");
const identity = lines.find((l) => l.attachment?.identity?.modelId)?.attachment.identity.modelId as string;
const usage = assistant[0].message.usage;
const priced = priceSession(identity, {
  input: usage.input_tokens,
  output: usage.output_tokens,
  cache_read: usage.cache_read_input_tokens,
  cache_write: usage.cache_creation_input_tokens,
}).usd!;

function resultJson(over: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: assistant.length,
    result: "Done.",
    session_id: assistant[0].sessionId,
    total_cost_usd: priced,
    usage,
    modelUsage: {
      [identity]: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadInputTokens: usage.cache_read_input_tokens,
        cacheCreationInputTokens: usage.cache_creation_input_tokens,
        costUSD: priced,
      },
    },
    stop_reason: "end_turn",
    ...over,
  };
}

// ---------- stub `claude` on PATH ----------
// Records argv/env/cwd per attempt, optionally edits a file (the "agent's work"), sleeps, then prints
// resp-<n>.json (or resp.json) and exits with exit-<n> (default 0).
const STUB = `#!/bin/bash
d="$STUB_DIR"
n=$(( $(cat "$d/count" 2>/dev/null || echo 0) + 1 )); echo $n > "$d/count"
printf '%s\\n' "$@" > "$d/args-$n"; env > "$d/env-$n"; pwd -P > "$d/cwd-$n"
[ -f "$d/edit" ] && cat "$d/edit" >> app.txt
[ -f "$d/sleep" ] && { sleep "$(cat "$d/sleep")" & wait; }
f="$d/resp-$n.json"; [ -f "$f" ] || f="$d/resp.json"
[ -f "$f" ] && cat "$f"
exit "$(cat "$d/exit-$n" 2>/dev/null || echo 0)"
`;

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
  tmp = mkdtempSync(join(tmpdir(), "roster-harness-claude-"));
  source = join(tmp, "source");
  mkdirSync(source);
  git(source, "init", "-q");
  writeFileSync(join(source, "app.txt"), "base\n");
  writeFileSync(join(source, "CLAUDE.md"), "# original rules\n");
  git(source, "add", "-A");
  git(source, "commit", "-qm", "base");
  binDir = join(tmp, "bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "claude"), STUB);
  chmodSync(join(binDir, "claude"), 0o755);
  rules = join(tmp, "rules.md");
  writeFileSync(rules, "# setup rules\n- run bun test\n");
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  stubDir = join(tmp, `stub-${++n}`);
  mkdirSync(stubDir);
});

async function opts(over: Partial<HarnessRunOptions> = {}): Promise<HarnessRunOptions> {
  const sb = await createSandbox(source, git(source, "rev-parse", "HEAD"), { root: join(tmp, "sandboxes") });
  return {
    sandboxPath: sb.path,
    prompt: "Add a line to app.txt",
    model: "opus",
    rulesFile: rules,
    maxTurns: 7,
    timeoutMs: 10_000,
    budgetUsd: 0.25,
    retryBaseMs: 1,
    env: { PATH: `${binDir}:${process.env.PATH}`, STUB_DIR: stubDir },
    ...over,
  };
}
const put = (name: string, v: unknown) => writeFileSync(join(stubDir, name), typeof v === "string" ? v : JSON.stringify(v));
const args = (k = 1) => readFileSync(join(stubDir, `args-${k}`), "utf8").split("\n").slice(0, -1);
const flag = (a: string[], f: string) => a[a.indexOf(f) + 1];

describe("runClaude with a stub claude", () => {
  test("success: metrics, resolved model, raw JSON, patch excludes the rules swap", async () => {
    put("resp.json", resultJson());
    put("edit", "agent line\n");
    const o = await opts();
    const r = await runClaude(o);

    expect(r.isError).toBe(false);
    expect(r.errorKind).toBeNull();
    expect(r.sessionId).toBe(assistant[0].sessionId);
    expect(r.turns).toBe(assistant.length);
    expect(r.costUsd).toBeCloseTo(priced, 10);
    expect(r.costUsd!).toBeGreaterThan(0);
    expect(r.model).toBe(identity); // resolved from modelUsage, not the "opus" flag
    expect(r.tokens).toEqual({ input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens });
    expect(r.durationMs).toBeGreaterThanOrEqual(0); // no duration_ms in the sample: falls back to wall clock
    expect(r.attempts).toHaveLength(1);

    expect(JSON.parse(readFileSync(r.transcriptPath!, "utf8")).session_id).toBe(assistant[0].sessionId);
    expect(r.transcriptPath!.startsWith(`${o.sandboxPath}/`)).toBe(false);

    // rules swapped in and committed as setup:
    expect(readFileSync(join(o.sandboxPath, "CLAUDE.md"), "utf8")).toBe(readFileSync(rules, "utf8"));
    expect(git(o.sandboxPath, "log", "-1", "--format=%s", r.setupSha!)).toStartWith("setup:");
    expect(git(o.sandboxPath, "show", `${r.setupSha}:CLAUDE.md`)).toContain("setup rules");

    const patch = readFileSync(r.diff!.patchPath, "utf8");
    expect(r.diff!.files).toEqual(["app.txt"]);
    expect(r.diff!.added).toBe(1);
    expect(patch).toContain("+agent line");
    expect(patch).not.toContain("CLAUDE.md");
    expect(readFileSync(join(stubDir, "cwd-1"), "utf8").trim()).toBe(Bun.spawnSync(["pwd", "-P"], { cwd: o.sandboxPath }).stdout.toString().trim());
  });

  test("passes the exact headless flags", async () => {
    put("resp.json", resultJson());
    await runClaude(await opts({ allowedTools: ["Read", "Bash(bun test:*)"] }));
    const a = args();
    expect(flag(a, "-p")).toBe("Add a line to app.txt");
    expect(flag(a, "--model")).toBe("opus");
    expect(flag(a, "--output-format")).toBe("json");
    expect(flag(a, "--max-turns")).toBe("7");
    expect(flag(a, "--permission-mode")).toBe("acceptEdits");
    expect(flag(a, "--permission-prompts")).toBe("none");
    expect(flag(a, "--allowedTools")).toBe("Read,Bash(bun test:*)");
    expect(flag(a, "--setting-sources")).toBe("project");
    expect(flag(a, "--max-budget-usd")).toBe("0.25");
    expect(a).toContain("--strict-mcp-config");
    expect(a).toContain("--disable-slash-commands");
  });

  test("scrubs host-session variables from the child env", async () => {
    put("resp.json", resultJson());
    const o = await opts();
    o.env = { ...o.env, CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "host", CLAUDE_CODE_MESSAGING_SOCKET: "/s", CLAUDE_CODE_MESSAGING_TOKEN: "t", ROSTER_KEEP: "yes" };
    await runClaude(o);
    const env = readFileSync(join(stubDir, "env-1"), "utf8");
    expect(env).not.toMatch(/^CLAUDECODE=/m);
    expect(env).not.toMatch(/^CLAUDE_CODE_SESSION_ID=/m);
    expect(env).not.toMatch(/^CLAUDE_CODE_MESSAGING_/m);
    expect(env).toMatch(/^ROSTER_KEEP=yes$/m);
    expect(Object.keys(childEnv({ CLAUDECODE: "1" }))).not.toContain("CLAUDECODE");
  });

  test("timeout kills the run and returns errorKind timeout", async () => {
    put("sleep", "30");
    put("edit", "partial\n");
    const t0 = Date.now();
    const r = await runClaude(await opts({ timeoutMs: 400 }));
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.isError).toBe(true);
    expect(r.errorKind).toBe("timeout");
    expect(r.attempts).toHaveLength(1); // timeouts are not retried
    expect(r.diff!.files).toEqual(["app.txt"]); // partial work is still captured
  });

  test("agent error is returned, not thrown, and not retried", async () => {
    put("resp.json", resultJson({ is_error: true, result: "Invalid API key · Please run /login" }));
    put("exit-1", "1");
    const r = await runClaude(await opts());
    expect(r.isError).toBe(true);
    expect(r.errorKind).toBe("agent_error");
    expect(r.attempts).toHaveLength(1);
  });

  test("max turns maps to errorKind max_turns", async () => {
    put("resp.json", resultJson({ subtype: "error_max_turns", is_error: true }));
    const r = await runClaude(await opts());
    expect(r.errorKind).toBe("max_turns");
  });

  test("missing binary and garbage output never throw", async () => {
    const missing = await runClaude(await opts({ bin: join(tmp, "nope", "claude") }));
    expect(missing.isError).toBe(true);
    expect(missing.errorKind).toBe("spawn_failed");
    put("resp.json", "not json at all");
    const garbage = await runClaude(await opts());
    expect(garbage.errorKind).toBe("unparseable_output");
    expect(existsSync(garbage.transcriptPath!)).toBe(true);
  });

  test("missing rules file returns setup_failed", async () => {
    const r = await runClaude(await opts({ rulesFile: join(tmp, "missing.md") }));
    expect(r.isError).toBe(true);
    expect(r.errorKind).toBe("setup_failed");
    expect(r.attempts).toHaveLength(0);
  });

  test("retries 5xx then succeeds; attempts are numbered and partial work is reset", async () => {
    put("resp-1.json", resultJson({ is_error: true, result: "API Error: 529 Overloaded" }));
    put("exit-1", "1");
    put("resp-2.json", resultJson({ is_error: true, result: "API Error: 429 rate limited" }));
    put("exit-2", "1");
    put("resp-3.json", resultJson());
    put("edit", "x\n");
    const r = await runClaude(await opts());
    expect(r.attempts.map((a) => [a.n, a.apiStatus, a.isError])).toEqual([[1, 529, true], [2, 429, true], [3, null, false]]);
    expect(r.attempts.map((a) => a.rawPath.endsWith(`claude.attempt-${a.n}.json`))).toEqual([true, true, true]);
    expect(r.isError).toBe(false);
    expect(r.costUsd).toBeCloseTo(priced * 3, 10);
    expect(r.diff!.added).toBe(1); // earlier attempts' edits were thrown away
  });

  test("gives up after 2 retries with the last API error kind", async () => {
    put("resp.json", resultJson({ is_error: true, result: "API Error: 500 Internal server error" }));
    put("exit-1", "1");
    const r = await runClaude(await opts());
    expect(r.attempts).toHaveLength(3);
    expect(r.errorKind).toBe("server_error");
  });
});

describe("parsing helpers", () => {
  test("apiStatusOf reads result text and stderr", () => {
    expect(apiStatusOf({ result: "API Error: 529 {}" }, "")).toBe(529);
    expect(apiStatusOf(null, "429 rate limit exceeded")).toBe(429);
    expect(apiStatusOf({ result: "Fixed 500 lines" }, "")).toBeNull();
  });
  test("resolvedModel picks the costliest modelUsage entry", () => {
    const r = resolvedModel({ modelUsage: { "claude-haiku-5-5": { costUSD: 0.001 }, [identity]: { costUSD: priced } } });
    expect(r.model).toBe(identity);
    expect(r.models).toHaveLength(2);
    expect(resolvedModel({}).model).toBeNull();
  });
});

// ---------- live (opt-in) ----------
describe.if(process.env.ROSTER_LIVE === "1")("live claude", () => {
  test(
    "trivial task with the cheapest model reports cost > 0",
    async () => {
      const r = await runClaude(
        await opts({
          prompt: "Append the line `hello` to app.txt. Do nothing else.",
          model: "claude-haiku-5-5",
          maxTurns: 4,
          timeoutMs: 180_000,
          budgetUsd: 0.2,
          retryBaseMs: 2000,
          env: { CLAUDE_CONFIG_DIR: process.env.ROSTER_CLAUDE_CONFIG ?? join(homedir(), ".roster-claude") },
        }),
      );
      expect(r.isError).toBe(false);
      expect(r.costUsd!).toBeGreaterThan(0);
      expect(r.model).toMatch(/haiku/);
    },
    240_000,
  );
});
