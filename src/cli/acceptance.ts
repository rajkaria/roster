// `roster acceptance --backlog <file> --out experiments/acceptance/`: writes frozen acceptance tests for each
// backlog task (DESIGN.md §"Forward run"). Calls DeepSeek via src/llm.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "../cli.ts";
import { acceptanceModel, generateAcceptance } from "../forward/acceptance.ts";
import { deepseekClient } from "../llm/client.ts";
import { UsageError } from "./review.ts";

export const DEFAULT_OUT = "experiments/acceptance/";

const USAGE = `usage: roster acceptance --backlog <file> [--out <dir>]

  --backlog <file>  the forward backlog (## Fxx: title blocks, each with an INTERFACE: line)
  --out <dir>       where <Fxx>/acceptance.test.ts and INDEX.json go (default ${DEFAULT_OUT})

Existing acceptance files are frozen and never overwritten. Model: ROSTER_ACCEPTANCE_MODEL (default deepseek-v4-pro).`;

export interface AcceptanceArgs {
  backlog: string;
  out: string;
}

/** Parses the arguments after `acceptance`. Throws UsageError on anything it does not accept. */
export function parseAcceptanceArgs(args: string[]): AcceptanceArgs {
  let backlog: string | undefined;
  let out = DEFAULT_OUT;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);
    const takeValue = (): string => {
      if (eq !== -1) return a.slice(eq + 1);
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${name} needs a value`);
      return v;
    };
    if (name === "--backlog") backlog = takeValue();
    else if (name === "--out") out = takeValue();
    else throw new UsageError(`unexpected argument ${a}`);
  }
  if (backlog === undefined) throw new UsageError("missing --backlog");
  return { backlog, out };
}

export const acceptanceCommand: Command = {
  name: "acceptance",
  summary: "write frozen acceptance tests for the forward backlog",
  usage: USAGE,
  async run(args) {
    let parsed: AcceptanceArgs;
    try {
      parsed = parseAcceptanceArgs(args);
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      console.error(`roster acceptance: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    const res = await generateAcceptance({
      backlog: readFileSync(parsed.backlog, "utf8"),
      outDir: resolve(parsed.out),
      client: deepseekClient(),
      model: acceptanceModel(),
      typesSource: readFileSync(join(import.meta.dir, "..", "types.ts"), "utf8"),
    });
    console.log(`written ${res.written.length}, frozen ${res.skipped.length}, failed ${res.failed.length}`);
    if (res.failed.length) console.error(`rejected twice (output implemented the interface): ${res.failed.join(", ")}`);
    return res.failed.length ? 1 : 0;
  },
};
