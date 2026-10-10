// `roster forward --backlog <file> --pair OLD,NEW --parallel 4`: paired runs with blind grading (DESIGN.md §"Forward run").
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "../cli.ts";
import { deepseekClient } from "../llm/client.ts";
import { DEFAULT_FORWARD_DB, runForward } from "../forward/index.ts";
import { UsageError } from "./review.ts";

const USAGE = `usage: roster forward --backlog <file> --pair OLD,NEW [--parallel <n>] [--db <path>] [--acceptance <dir>] [--seed <n>]

  --backlog <file>    task blocks between "<!-- Txx -->" and "<!-- /Txx -->"
  --pair OLD,NEW      the two setup ids (setups/<id>.json); OLD is the incumbent
  --parallel <n>      tasks in flight at once (default 4)
  --db <path>         state database; finished pairs are skipped on a rerun (default ${DEFAULT_FORWARD_DB})
  --acceptance <dir>  pre-committed acceptance tests, one folder per task (default experiments/acceptance)
  --seed <n>          run seed for labels and tie-breaks (default random, printed)

The blind diff-judge runs on DeepSeek; set DEEPSEEK_API_KEY in .env.`;

export interface ForwardArgs {
  backlog: string;
  old: string;
  new: string;
  parallel: number;
  db: string;
  acceptance: string | undefined;
  seed: number | undefined;
}

const FLAGS = ["--backlog", "--pair", "--parallel", "--db", "--acceptance", "--seed"];

/** Parses the arguments after `forward`. Throws UsageError on anything it does not accept. */
export function parseForwardArgs(args: string[]): ForwardArgs {
  const v: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);
    if (!FLAGS.includes(name)) throw new UsageError(`unknown argument ${a}`);
    const val = eq !== -1 ? a.slice(eq + 1) : args[++i];
    if (val === undefined || val.startsWith("--")) throw new UsageError(`${name} needs a value`);
    v[name] = val;
  }
  if (!v["--backlog"]) throw new UsageError("--backlog is required");
  const pair = v["--pair"]?.split(",") ?? [];
  if (pair.length !== 2 || pair.some((s) => !s)) throw new UsageError("--pair needs OLD,NEW");
  const num = (name: string, dflt: number | undefined) => {
    if (v[name] === undefined) return dflt;
    const n = Number(v[name]);
    if (!Number.isInteger(n) || n < 0) throw new UsageError(`${name} must be a non-negative integer, got ${v[name]}`);
    return n;
  };
  const parallel = num("--parallel", 4)!;
  if (parallel < 1) throw new UsageError("--parallel must be at least 1");
  return {
    backlog: v["--backlog"],
    old: pair[0]!,
    new: pair[1]!,
    parallel,
    db: v["--db"] ?? DEFAULT_FORWARD_DB,
    acceptance: v["--acceptance"],
    seed: num("--seed", undefined),
  };
}

export const forwardCommand: Command = {
  name: "forward",
  summary: "run backlog tasks through two setups, grade blind, merge the winner",
  usage: USAGE,
  async run(args) {
    let a: ForwardArgs;
    try {
      a = parseForwardArgs(args);
    } catch (e) {
      if (!(e instanceof UsageError)) throw e;
      console.error(`roster forward: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    const res = await runForward({
      repo: process.cwd(),
      backlog: readFileSync(resolve(a.backlog), "utf8"),
      pair: { old: a.old, new: a.new },
      parallel: a.parallel,
      llm: deepseekClient(),
      db: a.db,
      acceptanceDir: a.acceptance,
      seed: a.seed,
      log: (l) => console.log(l),
    });
    const { stop } = res;
    console.log(
      `forward: ${res.completed.length} pairs this run, ${res.skipped.length} already done, ${stop.pairs} total; new won ${stop.won}, lost ${stop.lost} discordant`,
    );
    if (res.reverted) console.log(`forward: stop rule triggered${res.reverted.url ? `, revert PR ${res.reverted.url}` : " (revert PR stubbed)"}`);
    return 0;
  },
};
