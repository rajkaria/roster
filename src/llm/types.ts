// Provider-neutral chat shapes for Roster's own model calls (DESIGN.md §"Models Roster itself uses").
// They mirror OpenAI chat completions with tool calling, which is the wire format DeepSeek serves.

export type Role = "system" | "user" | "assistant" | "tool";

/** One tool call the model asked for. `arguments` is the raw JSON string the model wrote; it may be malformed. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** A function tool offered to the model. `parameters` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** Default: env ROSTER_LLM_MODEL, else DEFAULT_MODEL. */
  model?: string;
  temperature?: number;
}

export interface ChatUsage {
  /** Total prompt tokens, cached included. */
  promptTokens: number;
  /** Prompt tokens served from the provider's cache. */
  cachedPromptTokens: number;
  completionTokens: number;
}

export interface ChatResult {
  /** The assistant turn, ready to append to the conversation. */
  message: Extract<ChatMessage, { role: "assistant" }>;
  toolCalls: ToolCall[];
  usage: ChatUsage;
  /** Priced via src/price. Null when the model has no confirmed price; never a guess. */
  costUsd: number | null;
  /** The model the provider says answered. */
  model: string;
}

export interface LlmClient {
  chat(req: ChatRequest): Promise<ChatResult>;
}

export const DEFAULT_MODEL = "deepseek-flash";
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
