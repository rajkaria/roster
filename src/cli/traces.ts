// `roster traces`: the neatlogs traces a flush could not deliver (T81). `list` shows the spool in .roster/traces;
// `flush` re-POSTs each saved trace to the neatlogs ingest endpoint and deletes the ones that arrive.
import type { Command } from "../cli.ts";
import { DEFAULT_INGEST_ENDPOINT, DEFAULT_SPOOL_DIR, flushSpool, listSpool } from "../obs/spool.ts";

const USAGE = `usage: roster traces <list|flush> [--dir <path>] [--endpoint <url>]

  list              show the traces saved for retry
  flush             re-send every saved trace (3 attempts each, with backoff); a trace that arrives is deleted
  --dir <path>      the trace spool (default ${DEFAULT_SPOOL_DIR})
  --endpoint <url>  the neatlogs ingest base URL (default ${DEFAULT_INGEST_ENDPOINT})

flush reads the API key from NEATLOGS_API_KEY.`;

export interface TracesDeps {
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  backoffMs?: number;
  out?: (msg: string) => void;
  err?: (msg: string) => void;
}

/** Runs `roster traces` with the arguments after its name. Resolves to the exit code. */
export async function runTraces(args: string[], deps: TracesDeps = {}): Promise<number> {
  const out = deps.out ?? ((m: string) => console.log(m));
  const err = deps.err ?? ((m: string) => console.error(m));
  const [sub, ...rest] = args;
  let dir = DEFAULT_SPOOL_DIR;
  let endpoint = DEFAULT_INGEST_ENDPOINT;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const v = rest[i + 1];
    if ((a === "--dir" || a === "--endpoint") && v !== undefined && !v.startsWith("--")) {
      if (a === "--dir") dir = v;
      else endpoint = v;
      i++;
    } else {
      err(`roster traces: unexpected argument ${a}\n\n${USAGE}`);
      return 2;
    }
  }

  if (sub === "list") {
    const saved = listSpool(dir);
    if (saved.length === 0) {
      out("no saved traces");
      return 0;
    }
    for (const t of saved) out(`${t.traceId}  ${t.spans} spans  ${t.bytes} bytes  saved ${t.savedAt.toISOString()}`);
    return 0;
  }
  if (sub === "flush") {
    const apiKey = (deps.env ?? process.env).NEATLOGS_API_KEY;
    if (!apiKey) {
      err("roster traces flush: NEATLOGS_API_KEY is not set");
      return 1;
    }
    const results = await flushSpool({ dir, endpoint, apiKey, fetch: deps.fetch, backoffMs: deps.backoffMs, print: out });
    if (results.length === 0) out("no saved traces");
    return results.every((r) => r.sent) ? 0 : 1;
  }
  err(`roster traces: ${sub === undefined ? "missing subcommand" : `unknown subcommand ${sub}`}\n\n${USAGE}`);
  return 2;
}

export const tracesCommand: Command = {
  name: "traces",
  summary: "list or re-send the neatlogs traces a flush could not deliver",
  usage: USAGE,
  run: (args) => runTraces(args),
};
