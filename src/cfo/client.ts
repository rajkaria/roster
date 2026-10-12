// The cfo.ai MCP bridge. writeBook (src/cfo/mcp.ts) needs a client with call(tool, args); this one runs
// `claude -p` with only the `cfoai` MCP server loaded (--strict-mcp-config) and only the named tool allowed,
// asks it to call that tool with the given JSON and return the tool result verbatim as JSON. A server that is
// missing or not authenticated surfaces as CfoNotConnectedError with the exact command that fixes it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CFO_MCP_URL = "https://api.cfo.ai/mcp";
export const CFO_SERVER = "cfoai";
export const NOT_CONNECTED_MESSAGE = `cfo.ai not connected: run \`claude mcp add --transport http ${CFO_SERVER} ${CFO_MCP_URL}\``;

/** The marker the fixed prompt asks the model to answer with when the tool is unavailable. */
const NOT_CONNECTED_MARKER = "CFO_NOT_CONNECTED";

export class CfoNotConnectedError extends Error {
  readonly code = "CFO_NOT_CONNECTED" as const;
  constructor(readonly detail = "") {
    super(NOT_CONNECTED_MESSAGE);
    this.name = "CfoNotConnectedError";
  }
}

export class CfoBridgeError extends Error {
  readonly code = "CFO_BRIDGE" as const;
  constructor(message: string) {
    super(message);
    this.name = "CfoBridgeError";
  }
}

export type CfoClientOptions = {
  /** The claude binary. Defaults to $ROSTER_CLAUDE_BIN, then `claude` on PATH. */
  bin?: string;
  /** An --mcp-config value (a JSON string or file path). Defaults to an http server `cfoai` at CFO_MCP_URL. */
  mcpConfig?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  /** Where the bridge runs. Defaults to a fresh temp dir, outside any repo, so session recorders (Entire) never log it. */
  cwd?: string;
};

export type CfoClient = { call(tool: string, args: Record<string, unknown>): Promise<unknown> };

export const defaultMcpConfig = (): string =>
  JSON.stringify({ mcpServers: { [CFO_SERVER]: { type: "http", url: CFO_MCP_URL } } });

export function bridgePrompt(tool: string, args: Record<string, unknown>): string {
  return [
    `Call the MCP tool mcp__${CFO_SERVER}__${tool} exactly once, with the JSON arguments below.`,
    "Return the tool result verbatim as JSON and nothing else: no prose, no code fences.",
    `If that tool is not available, or the server is not configured or not authenticated, reply with exactly ${NOT_CONNECTED_MARKER}.`,
    `TOOL: ${tool}`,
    `ARGS: ${JSON.stringify(args)}`,
  ].join("\n");
}

export function bridgeArgs(tool: string, args: Record<string, unknown>, mcpConfig: string): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    // Project settings only: the operator's own CLAUDE.md and user settings stay out of the bridge session.
    "--setting-sources",
    "project",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfig,
    "--tools",
    "",
    "--allowedTools",
    `mcp__${CFO_SERVER}__${tool}`,
    // --tools and --allowedTools take lists: without "--" the prompt is read as one more tool name.
    "--",
    bridgePrompt(tool, args),
  ];
}

const NOT_CONNECTED_RE =
  /CFO_NOT_CONNECTED|not (?:configured|authenticated|connected)|needs?[ -]auth|unauthori[sz]ed|\b401\b|no such tool|tool .* (?:is )?not (?:available|found)|mcp server .*(?:failed|not found)/i;

export const looksNotConnected = (text: string): boolean => NOT_CONNECTED_RE.test(text);

const stripFences = (s: string): string =>
  s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

/** Parse `claude -p --output-format json` stdout into the tool result. Throws the typed errors. */
export function parseBridgeOutput(stdout: string, stderr: string, exitCode: number): unknown {
  let envelope: { result?: unknown; is_error?: boolean } | null = null;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    envelope = null;
  }
  const resultText = typeof envelope?.result === "string" ? envelope.result : null;
  if (exitCode !== 0 || envelope === null || resultText === null || envelope.is_error) {
    const all = `${stderr}\n${stdout}`;
    if (looksNotConnected(all)) throw new CfoNotConnectedError(all.trim());
    throw new CfoBridgeError(`claude -p failed (exit ${exitCode}): ${all.trim().slice(0, 500)}`);
  }
  const body = stripFences(resultText);
  if (body === NOT_CONNECTED_MARKER) throw new CfoNotConnectedError(body);
  try {
    return JSON.parse(body);
  } catch {
    if (looksNotConnected(body)) throw new CfoNotConnectedError(body);
    throw new CfoBridgeError(`cfo.ai tool result was not JSON: ${body.slice(0, 500)}`);
  }
}

export function createCfoClient(opts: CfoClientOptions = {}): CfoClient {
  const env = opts.env ?? process.env;
  const bin = opts.bin ?? env.ROSTER_CLAUDE_BIN ?? "claude";
  const mcpConfig = opts.mcpConfig ?? env.ROSTER_CFO_MCP_CONFIG ?? defaultMcpConfig();
  const timeoutMs = opts.timeoutMs ?? 180_000;
  let cwd = opts.cwd;

  return {
    async call(tool, args) {
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        cwd ??= mkdtempSync(join(tmpdir(), "roster-cfo-bridge-"));
        proc = Bun.spawn([bin, ...bridgeArgs(tool, args, mcpConfig)], {
          cwd,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: env as Record<string, string>,
        });
      } catch (e) {
        throw new CfoBridgeError(`could not run ${bin}: ${e instanceof Error ? e.message : String(e)}`);
      }
      const timer = setTimeout(() => proc.kill(), timeoutMs);
      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout as ReadableStream).text(),
          new Response(proc.stderr as ReadableStream).text(),
          proc.exited,
        ]);
        return parseBridgeOutput(stdout, stderr, exitCode);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
