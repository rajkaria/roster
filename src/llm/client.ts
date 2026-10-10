// Roster's own model calls, on DeepSeek's OpenAI-compatible API. Never a Claude API
// (DESIGN.md §"Models Roster itself uses"). Retries 429/5xx twice with backoff (§"Recovery").
import OpenAI from "openai";
import { traceOpenAI, withSpan } from "../obs/index.ts";
import { priceSession } from "../price/index.ts";
import {
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type ChatUsage,
  DEEPSEEK_BASE_URL,
  DEFAULT_MODEL,
  type LlmClient,
  type ToolCall,
} from "./types.ts";

export * from "./types.ts";

/** The slice of an OpenAI-style chat completion response the client reads. */
export interface RawCompletion {
  model: string;
  choices: {
    message: {
      content: string | null;
      tool_calls?: (
        | { id: string; type: "function"; function: { name: string; arguments: string } }
        | { id: string; type: "custom"; custom: { name: string; input: string } }
      )[];
    };
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
    /** DeepSeek's own cache counter. */
    prompt_cache_hit_tokens?: number;
  };
}

/** Sends one chat completion request. The default goes through the `openai` package. */
export type Transport = (body: Record<string, unknown>) => Promise<RawCompletion>;

export interface DeepSeekOptions {
  /** Default: env DEEPSEEK_API_KEY. */
  apiKey?: string;
  baseURL?: string;
  /** Default: env ROSTER_LLM_MODEL, else DEFAULT_MODEL. */
  model?: string;
  /** Retries on 429/5xx only. Default 2. */
  maxRetries?: number;
  /** First backoff delay; doubles per retry. Default 1000. */
  retryBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Replaces the network call. Tests use it; production leaves it unset. */
  transport?: Transport;
}

/** The model a call uses when the request names none. */
export function defaultModel(): string {
  return process.env.ROSTER_LLM_MODEL || DEFAULT_MODEL;
}

/** HTTP status carried by an SDK or fetch error, else null. */
export function errorStatus(err: unknown): number | null {
  if (typeof err === "object" && err !== null && "status" in err) {
    const s = (err as { status: unknown }).status;
    if (typeof s === "number") return s;
  }
  return null;
}

/** True for the failures worth retrying: rate limits and server errors. */
export function isRetryable(err: unknown): boolean {
  const s = errorStatus(err);
  return s !== null && (s === 429 || s >= 500);
}

function toWire(m: ChatMessage): Record<string, unknown> {
  if (m.role !== "assistant" || !m.tool_calls?.length) return { ...m };
  return {
    role: "assistant",
    content: m.content,
    tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
  };
}

/** Maps a raw completion to a ChatResult, priced for its model via src/price. */
export function toResult(raw: RawCompletion): ChatResult {
  const msg = raw.choices[0]?.message ?? { content: null };
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c) =>
    c.type === "function"
      ? { id: c.id, name: c.function.name, arguments: c.function.arguments }
      : { id: c.id, name: c.custom.name, arguments: c.custom.input },
  );
  const u = raw.usage;
  const cached = u?.prompt_cache_hit_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? 0;
  const usage: ChatUsage = {
    promptTokens: u?.prompt_tokens ?? 0,
    cachedPromptTokens: cached,
    completionTokens: u?.completion_tokens ?? 0,
  };
  const costUsd = u
    ? priceSession(raw.model, {
        input: usage.promptTokens - cached,
        output: usage.completionTokens,
        cache_read: cached,
        prompt_tokens: usage.promptTokens,
      }).usd
    : null;
  return {
    message: { role: "assistant", content: msg.content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
    toolCalls,
    usage,
    costUsd,
    model: raw.model,
  };
}

/** A client for DeepSeek's chat completions. Throws when no API key is configured and no transport is given. */
export function deepseekClient(opts: DeepSeekOptions = {}): LlmClient {
  const maxRetries = opts.maxRetries ?? 2;
  const baseMs = opts.retryBaseMs ?? 1000;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  let transport = opts.transport;
  if (!transport) {
    const apiKey = opts.apiKey ?? process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set; Roster's own model calls go to DeepSeek");
    // The SDK's own retries are off: ours are numbered and traced.
    const sdk = new OpenAI({ apiKey, baseURL: opts.baseURL ?? DEEPSEEK_BASE_URL, maxRetries: 0 });
    // Wrapped per call: the CLI builds this client before initObs runs, and traceOpenAI is a no-op until tracing is on.
    transport = (body) => traceOpenAI(sdk).chat.completions.create(body as never) as Promise<RawCompletion>;
  }
  const send = transport;

  return {
    async chat(req: ChatRequest): Promise<ChatResult> {
      const body: Record<string, unknown> = {
        model: req.model ?? opts.model ?? defaultModel(),
        messages: req.messages.map(toWire),
      };
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.tools?.length) {
        body.tools = req.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      }
      for (let attempt = 1; ; attempt++) {
        try {
          if (attempt === 1) return toResult(await send(body));
          // Retries are a recovery path, so each one is a TOOL span carrying roster.attempt.
          return await withSpan("TOOL", "llm retry", { attempt }, async () => toResult(await send(body)));
        } catch (err) {
          if (!isRetryable(err) || attempt > maxRetries) throw err;
          await sleep(baseMs * 2 ** (attempt - 1));
        }
      }
    },
  };
}

/** One scripted reply: a partial result, a function of the request, or an error to throw. */
export type FakeStep =
  | { content?: string | null; toolCalls?: ToolCall[]; costUsd?: number | null; usage?: Partial<ChatUsage>; model?: string }
  | ((req: ChatRequest) => FakeStep)
  | Error;

export interface FakeClient extends LlmClient {
  /** Every request received, in order. */
  requests: ChatRequest[];
}

/** A scripted client for tests. Each chat() consumes one step; running out throws. */
export function fakeClient(steps: FakeStep[]): FakeClient {
  const queue = [...steps];
  const requests: ChatRequest[] = [];
  return {
    requests,
    async chat(req) {
      requests.push(structuredClone(req));
      let step = queue.shift();
      if (step === undefined) throw new Error("fake LLM client: script exhausted");
      while (typeof step === "function") step = step(req);
      if (step instanceof Error) throw step;
      const toolCalls = step.toolCalls ?? [];
      return {
        message: { role: "assistant", content: step.content ?? null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
        toolCalls,
        usage: { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0, ...step.usage },
        costUsd: step.costUsd === undefined ? 0 : step.costUsd,
        model: step.model ?? req.model ?? "fake",
      };
    },
  };
}

let fakeIds = 0;
/** A tool call for a fake script. Pass a string to script malformed JSON arguments. */
export function fakeToolCall(name: string, args: Record<string, unknown> | string = {}): ToolCall {
  return { id: `call_${++fakeIds}`, name, arguments: typeof args === "string" ? args : JSON.stringify(args) };
}
