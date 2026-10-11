import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { EventStore, resumeCommand, runCoordinator } from "../src/agent/coordinator.ts";
import type { ToolBackend } from "../src/agent/tools.ts";
import {
  type RawCompletion,
  deepseekClient,
  isNetworkError,
  isRetryable,
  LlmCallError,
  MAX_BACKOFF_MS,
  NETWORK_MAX_ATTEMPTS,
} from "../src/llm/client.ts";

// The transport stands in for the network. Errors are the openai SDK's own classes and Node-style errno errors;
// the completion is a chat-completions shape stub, as in tests/llm.test.ts.
const completion = (): RawCompletion => ({
  model: "deepseek-flash",
  choices: [{ message: { content: "ok" } }],
  usage: { prompt_tokens: 10, completion_tokens: 2 },
});
const errno = (code: string, message = `${code} at test`) => Object.assign(new Error(message), { code });
const connectionError = () => new OpenAI.APIConnectionError({ cause: errno("ECONNRESET", "read ECONNRESET") });
const hi = { messages: [{ role: "user" as const, content: "hi" }] };

describe("isNetworkError", () => {
  test("recognises connection failures and timeouts, through the cause chain", () => {
    expect(isNetworkError(connectionError())).toBe(true);
    expect(isNetworkError(new OpenAI.APIConnectionTimeoutError())).toBe(true);
    for (const code of ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"]) expect(isNetworkError(errno(code))).toBe(true);
    expect(isNetworkError(new Error("Connection error."))).toBe(true);
    expect(isNetworkError(new TypeError("fetch failed"))).toBe(true);
    expect(isNetworkError(new Error("socket hang up"))).toBe(true);
    expect(isNetworkError(new Error("outer", { cause: errno("EAI_AGAIN") }))).toBe(true);
    expect(isNetworkError(Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }))).toBe(true);
    expect(isRetryable(errno("ENOTFOUND"))).toBe(true);
  });

  test("leaves other failures alone", () => {
    expect(isNetworkError(new Error("invalid JSON"))).toBe(false);
    expect(isNetworkError(Object.assign(new Error("HTTP 400"), { status: 400 }))).toBe(false);
    expect(isRetryable(Object.assign(new Error("HTTP 401"), { status: 401 }))).toBe(false);
  });
});

describe("deepseekClient on a flaky network", () => {
  test("two connection errors then success: one result, three attempts", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const client = deepseekClient({
      retryBaseMs: 100,
      random: () => 0.5,
      sleep: async (ms) => void sleeps.push(ms),
      transport: async () => {
        calls++;
        if (calls === 1) throw connectionError();
        if (calls === 2) throw errno("EAI_AGAIN", "getaddrinfo EAI_AGAIN api.deepseek.com");
        return completion();
      },
    });
    const res = await client.chat(hi);
    expect(res.message.content).toBe("ok");
    expect(calls).toBe(3);
    // Exponential backoff plus jitter (half of the base delay here).
    expect(sleeps).toEqual([150, 250]);
  });

  test("persistent failure: error after six attempts, carrying the attempt count", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const client = deepseekClient({
      random: () => 0,
      sleep: async (ms) => void sleeps.push(ms),
      transport: async () => {
        calls++;
        throw connectionError();
      },
    });
    const err = await client.chat(hi).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmCallError);
    expect((err as LlmCallError).attempts).toBe(NETWORK_MAX_ATTEMPTS);
    expect((err as LlmCallError).message).toBe("Connection error. (6 attempts)");
    expect((err as LlmCallError).cause).toBeInstanceOf(OpenAI.APIConnectionError);
    expect(calls).toBe(6);
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  test("backoff is capped at 30 s plus jitter", async () => {
    const sleeps: number[] = [];
    const client = deepseekClient({
      retryBaseMs: 10_000,
      random: () => 0.99,
      sleep: async (ms) => void sleeps.push(ms),
      transport: async () => {
        throw new OpenAI.APIConnectionTimeoutError();
      },
    });
    await expect(client.chat(hi)).rejects.toThrow("Request timed out.");
    expect(sleeps).toHaveLength(5);
    for (const ms of sleeps.slice(2)) {
      expect(ms).toBeGreaterThanOrEqual(MAX_BACKOFF_MS);
      expect(ms).toBeLessThan(MAX_BACKOFF_MS + 10_000);
    }
  });

  test("a client error is not retried and reports one attempt", async () => {
    let calls = 0;
    const client = deepseekClient({
      sleep: async () => {},
      transport: async () => {
        calls++;
        throw Object.assign(new Error("HTTP 400"), { status: 400 });
      },
    });
    const err = (await client.chat(hi).catch((e: unknown) => e)) as LlmCallError;
    expect(calls).toBe(1);
    expect(err.attempts).toBe(1);
    expect(err.status).toBe(400);
  });
});

describe("coordinator on a persistent LLM failure", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "roster-llm-network-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("saves state, records the attempts and hands back the resume command", async () => {
    let calls = 0;
    const llm = deepseekClient({
      sleep: async () => {},
      transport: async () => {
        calls++;
        throw connectionError();
      },
    });
    const dbPath = join(dir, "roster.db");
    const opts = {
      repo: "owner/repo",
      budgetUsd: 2,
      llm,
      // The LLM fails before any tool runs, so the backend is never called.
      backend: {} as ToolBackend,
      outDir: join(dir, "out"),
      dbPath,
      runId: "run-test-1",
    };
    const res = await runCoordinator(opts);
    expect(calls).toBe(6);
    expect(res.outcome).toBe("llm_error");
    expect(res.summary).toContain("after 6 attempts");
    expect(res.summary).toContain("Connection error.");
    // The CLI prints res.summary as is, so the exact resume command reaches the user.
    expect(res.summary).toContain("roster run owner/repo --run-id run-test-1 --budget 2");

    const store = new EventStore(dbPath);
    const kinds = store.events("run-test-1").map((e) => e.kind);
    const note = store.events("run-test-1").find((e) => e.kind === "note");
    store.close();
    expect(kinds).toEqual(["start", "note", "end"]);
    expect(note?.payload.llm_error).toEqual({ message: "Connection error. (6 attempts)", attempts: 6 });

    // Resuming under the same id picks the run up rather than starting over.
    const again = await runCoordinator({ ...opts, llm: deepseekClient({ transport: async () => completion() }) });
    expect(again.resumed).toBe(true);
    expect(again.outcome).toBe("stopped");
    expect(again.turns).toBe(1);
  });

  test("the resume command quotes paths the shell would split", () => {
    expect(resumeCommand("/tmp/my repo", "run-1", 0.5)).toBe("roster run '/tmp/my repo' --run-id run-1 --budget 0.5");
  });
});
