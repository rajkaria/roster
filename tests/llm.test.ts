import { describe, expect, test } from "bun:test";
import {
  DEEPSEEK_BASE_URL,
  DEFAULT_MODEL,
  type RawCompletion,
  deepseekClient,
  defaultModel,
  fakeClient,
  fakeToolCall,
  isRetryable,
  toResult,
} from "../src/llm/client.ts";

// The transport stands in for the network. Its responses follow the chat-completions shape the client reads;
// no DeepSeek response is recorded in tests/fixtures yet, so these are shape stubs, not provider payloads.
const completion = (over: Partial<RawCompletion> = {}): RawCompletion => ({
  model: "deepseek-flash",
  choices: [{ message: { content: "ok" } }],
  usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 40 },
  ...over,
});

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("deepseekClient", () => {
  test("targets DeepSeek and defaults the model to deepseek-flash", () => {
    expect(DEEPSEEK_BASE_URL).toBe("https://api.deepseek.com");
    expect(DEFAULT_MODEL).toBe("deepseek-flash");
    withEnv({ ROSTER_LLM_MODEL: undefined }, () => expect(defaultModel()).toBe("deepseek-flash"));
    withEnv({ ROSTER_LLM_MODEL: "deepseek-v4-pro" }, () => expect(defaultModel()).toBe("deepseek-v4-pro"));
  });

  test("refuses to start without DEEPSEEK_API_KEY", () => {
    withEnv({ DEEPSEEK_API_KEY: undefined }, () => {
      expect(() => deepseekClient()).toThrow(/DEEPSEEK_API_KEY/);
    });
  });

  test("builds a client from the env key without calling the network", () => {
    withEnv({ DEEPSEEK_API_KEY: "test-not-a-key" }, () => {
      expect(typeof deepseekClient().chat).toBe("function");
    });
  });

  test("sends model, messages and function tools; maps tool calls back", async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = deepseekClient({
      model: "deepseek-flash",
      transport: async (body) => {
        bodies.push(body);
        return completion({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: "c1", type: "function", function: { name: "gate", arguments: '{"candidate":"E"}' } }],
              },
            },
          ],
        });
      },
    });
    const res = await client.chat({
      messages: [
        { role: "system", content: "s" },
        { role: "assistant", content: null, tool_calls: [{ id: "c0", name: "ingest_repo", arguments: "{}" }] },
        { role: "tool", tool_call_id: "c0", content: "{}" },
      ],
      tools: [{ name: "gate", description: "d", parameters: { type: "object", properties: {} } }],
      temperature: 0,
    });
    const body = bodies[0]!;
    expect(body.model).toBe("deepseek-flash");
    expect(body.temperature).toBe(0);
    expect(body.tools).toEqual([
      { type: "function", function: { name: "gate", description: "d", parameters: { type: "object", properties: {} } } },
    ]);
    expect((body.messages as unknown[])[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c0", type: "function", function: { name: "ingest_repo", arguments: "{}" } }],
    });
    expect(res.toolCalls).toEqual([{ id: "c1", name: "gate", arguments: '{"candidate":"E"}' }]);
    expect(res.message.tool_calls).toEqual(res.toolCalls);
    expect(res.model).toBe("deepseek-flash");
  });

  test("reports usage with cached tokens split out, and a price only when src/price knows the model", () => {
    const res = toResult(completion());
    expect(res.usage).toEqual({ promptTokens: 100, cachedPromptTokens: 40, completionTokens: 20 });
    // src/price/prices.json has no confirmed DeepSeek row, so the cost is unknown rather than guessed.
    expect(res.costUsd).toBeNull();
    expect(toResult(completion({ usage: undefined })).costUsd).toBeNull();
  });

  test("retries 429 and 5xx twice with doubling backoff, then succeeds", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const client = deepseekClient({
      retryBaseMs: 10,
      sleep: async (ms) => void sleeps.push(ms),
      transport: async () => {
        calls++;
        if (calls === 1) throw httpError(429);
        if (calls === 2) throw httpError(503);
        return completion();
      },
    });
    const res = await client.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(res.message.content).toBe("ok");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([10, 20]);
  });

  test("gives up after two retries", async () => {
    let calls = 0;
    const client = deepseekClient({
      sleep: async () => {},
      transport: async () => {
        calls++;
        throw httpError(500);
      },
    });
    await expect(client.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow("HTTP 500");
    expect(calls).toBe(3);
  });

  test("does not retry client errors", async () => {
    let calls = 0;
    const client = deepseekClient({
      sleep: async () => {},
      transport: async () => {
        calls++;
        throw httpError(400);
      },
    });
    await expect(client.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow("HTTP 400");
    expect(calls).toBe(1);
    expect(isRetryable(httpError(429))).toBe(true);
    expect(isRetryable(new Error("no status"))).toBe(false);
  });
});

describe("fakeClient", () => {
  test("replays a script, records requests, and throws when exhausted", async () => {
    const call = fakeToolCall("gate", { candidate: "E" });
    const client = fakeClient([
      { toolCalls: [call], costUsd: 0.01 },
      (req) => ({ content: `saw ${req.messages.length}` }),
      new Error("boom"),
    ]);
    const a = await client.chat({ messages: [{ role: "user", content: "go" }] });
    expect(a.toolCalls).toEqual([call]);
    expect(a.costUsd).toBe(0.01);
    const b = await client.chat({ messages: [{ role: "user", content: "1" }, { role: "user", content: "2" }] });
    expect(b.message.content).toBe("saw 2");
    expect(b.toolCalls).toEqual([]);
    await expect(client.chat({ messages: [] })).rejects.toThrow("boom");
    await expect(client.chat({ messages: [] })).rejects.toThrow("script exhausted");
    expect(client.requests).toHaveLength(4);
  });

  test("fakeToolCall can carry malformed arguments", () => {
    expect(fakeToolCall("gate", "{not json").arguments).toBe("{not json");
  });
});
