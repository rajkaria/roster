// `roster forward --backlog <file> --pair OLD,NEW --parallel 4`: paired runs with blind grading (DESIGN.md §"Forward run").
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "../cli.ts";
import { deepseekClient } from "../llm/client.ts";
import { DEFAULT_FORWARD_DB, MAX_PARALLEL, remergeForward, runForward } from "../forward/index.ts";
import type { ForwardPair } from "../types.ts";
import { UsageError } from "./review.ts";

const USAGE = `usage: roster forward --backlog <file> --pair OLD,NEW [--parallel <n>] [--db <path>] [--acceptance <dir>] [--seed <n>]
       roster forward --remerge --backlog <file> [--parallel <n>] [--db <path>]

  --backlog <file>    task blocks between "<!-- Txx -->" and "<!-- /Txx -->"
  --pair OLD,NEW      the two setup ids (setups/<id>.json); OLD is the incumbent
  --parallel <n>      tasks in flight at once, 1 to ${MAX_PARALLEL} (default ${MAX_PARALLEL})
  --db <path>         state database; finished pairs are skipped on a rerun (default ${DEFAULT_FORWARD_DB})
  --acceptance <dir>  pre-committed acceptance tests, one folder per task (default experiments/acceptance)
  --seed <n>          run seed for labels and tie-breaks (default random, printed)
  --remerge           revisit recorded pairs that merged nothing: re-grade suite and scope on both branches and
                      apply the merge policy below; acceptance results (H1) stay as recorded

Merge policy (pre-registration amendment 8; the build policy, not a measured outcome): an acceptance pass beats a fail.
If both fail acceptance, the side whose full suite passes with scope ok is merged; if both do, the blind judge picks;
if neither does, nothing is merged. Each pair also records an exploratory secondary outcome, never H1: the judge's
preference among the sides whose suite and scope pass.

The blind diff-judge runs on DeepSeek; set DEEPSEEK_API_KEY in .env.`;

export interface ForwardArgs {
  backlog: string;
  /** The setup pair; only --remerge runs without one (it reads the setups from the recorded pairs). */
  old: string | undefined;
  new: string | undefined;
  parallel: number;
  db: string;
  acceptance: string | undefined;
  seed: number | undefined;
  remerge: boolean;
}

const FLAGS = ["--backlog", "--pair", "--parallel", "--db", "--acceptance", "--seed"];
const SWITCHES = ["--remerge"];

/** Parses the arguments after `forward`. Throws UsageError on anything it does not accept. */
export function parseForwardArgs(args: string[]): ForwardArgs {
  const v: Record<string, string> = {};
  const on = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (SWITCHES.includes(a)) {
      on.add(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);
    if (!FLAGS.includes(name)) throw new UsageError(`unknown argument ${a}`);
    const val = eq !== -1 ? a.slice(eq + 1) : args[++i];
    if (val === undefined || val.startsWith("--")) throw new UsageError(`${name} needs a value`);
    v[name] = val;
  }
  const remerge = on.has("--remerge");
  if (!v["--backlog"]) throw new UsageError("--backlog is required");
  const pair = v["--pair"]?.split(",");
  if (pair ? pair.length !== 2 || pair.some((s) => !s) : !remerge) throw new UsageError("--pair needs OLD,NEW");
  const num = (name: string, dflt: number | undefined) => {
    if (v[name] === undefined) return dflt;
    const n = Number(v[name]);
    if (!Number.isInteger(n) || n < 0) throw new UsageError(`${name} must be a non-negative integer, got ${v[name]}`);
    return n;
  };
  const parallel = num("--parallel", MAX_PARALLEL)!;
  if (parallel < 1 || parallel > MAX_PARALLEL) throw new UsageError(`--parallel must be from 1 to ${MAX_PARALLEL}, got ${parallel}`);
  return {
    backlog: v["--backlog"],
    old: pair?.[0],
    new: pair?.[1],
    parallel,
    db: v["--db"] ?? DEFAULT_FORWARD_DB,
    acceptance: v["--acceptance"],
    seed: num("--seed", undefined),
    remerge,
  };
}

/** Tallies the secondary outcome, labelled so it is never read as H1. */
export function secondaryLine(pairs: ForwardPair[]): string | null {
  const counts: Record<string, number> = {};
  for (const p of pairs) if (p.secondary) counts[p.secondary] = (counts[p.secondary] ?? 0) + 1;
  const parts = ["old", "new", "tie", "none"].filter((k) => counts[k]).map((k) => `${k} ${counts[k]}`);
  return parts.length ? `forward: secondary outcome (exploratory, not H1): ${parts.join(", ")}` : null;
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
    const backlog = readFileSync(resolve(a.backlog), "utf8");
    const log = (l: string) => console.log(l);
    if (a.remerge) {
      const res = await remergeForward({ repo: process.cwd(), backlog, llm: deepseekClient(), db: a.db, parallel: a.parallel, log });
      const merged = res.revisited.filter((p) => p.merged).length;
      console.log(`forward: remerge revisited ${res.revisited.length} unmerged pairs, merged ${merged}, skipped ${res.skipped.length}`);
      const s = secondaryLine(res.revisited);
      if (s) console.log(s);
      return 0;
    }
    const res = await runForward({
      repo: process.cwd(),
      backlog,
      pair: { old: a.old!, new: a.new! },
      parallel: a.parallel,
      llm: deepseekClient(),
      db: a.db,
      acceptanceDir: a.acceptance,
      seed: a.seed,
      log,
      buildMerge: true,
    });
    const { stop } = res;
    console.log(
      `forward: ${res.completed.length} pairs this run, ${res.skipped.length} already done, ${stop.pairs} total; new won ${stop.won}, lost ${stop.lost} discordant`,
    );
    const s = secondaryLine(res.completed);
    if (s) console.log(s);
    if (res.reverted) console.log(`forward: stop rule triggered${res.reverted.url ? `, revert PR ${res.reverted.url}` : " (revert PR stubbed)"}`);
    return 0;
  },
};
