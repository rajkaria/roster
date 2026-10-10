// `roster run <repo> --budget <usd>`: the coordinator agent on DeepSeek, over the tool backend
// (DESIGN.md §"Coordinator tools"). One WORKFLOW span per run; the coordinator adds AGENT and TOOL spans.
import { join, resolve } from "node:path";
import type { Command } from "../cli.ts";
import { deepseekClient } from "../llm/client.ts";
import { flushObs, initObs, setSession, withSpan } from "../obs/index.ts";
import { repoLabel, reviewSlug } from "../review/export.ts";
import { DEFAULT_DB, newRunId, runCoordinator } from "../agent/coordinator.ts";
import { defaultBackend } from "../agent/backend.ts";
import { DEFAULT_CACHE, UsageError } from "./review.ts";

const USAGE = `usage: roster run <repo> --budget <usd> [--out <dir>] [--run-id <id>] [--db <path>] [--model <m>] [--cache <dir>]

  <repo>           a git URL or local path with Entire checkpoints
  --budget <usd>   hard stop for LLM plus replay cost (required)
  --out <dir>      where plan.json and decisions.json go (default reports/<slug>)
  --run-id <id>    resume this run from ${DEFAULT_DB}, or start it under this id
  --db <path>      state database (default ${DEFAULT_DB})
  --model <m>      coordinator model (default env ROSTER_LLM_MODEL, else deepseek-flash)
  --cache <dir>    fetch cache (default ${DEFAULT_CACHE})

Roster's own model calls go to DeepSeek; set DEEPSEEK_API_KEY in .env.`;

export interface RunArgs {
  repo: string;
  budgetUsd: number;
  out: string | undefined;
  runId: string | undefined;
  db: string;
  model: string | undefined;
  cache: string;
}

/** Parses the arguments after `run`. Throws UsageError on anything it does not accept. */
export function parseRunArgs(args: string[]): RunArgs {
  let repo: string | undefined;
  let budget: string | undefined;
  const parsed: Omit<RunArgs, "repo" | "budgetUsd"> = {
    out: undefined,
    runId: undefined,
    db: DEFAULT_DB,
    model: undefined,
    cache: DEFAULT_CACHE,
  };
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
    if (name === "--budget") budget = takeValue();
    else if (name === "--out") parsed.out = takeValue();
    else if (name === "--run-id") parsed.runId = takeValue();
    else if (name === "--db") parsed.db = takeValue();
    else if (name === "--model") parsed.model = takeValue();
    else if (name === "--cache") parsed.cache = takeValue();
    else if (a.startsWith("-")) throw new UsageError(`unknown flag ${a}`);
    else if (repo === undefined) repo = a;
    else throw new UsageError(`unexpected argument ${a}`);
  }
  if (repo === undefined) throw new UsageError("missing <repo>");
  if (budget === undefined) throw new UsageError("--budget is required");
  const budgetUsd = Number(budget);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new UsageError(`--budget must be a positive number, got ${budget}`);
  return { repo, budgetUsd, ...parsed };
}

/** Runs the coordinator. Exit 0 when it promoted or honestly found no better setup, 1 otherwise. */
export async function runRun(args: RunArgs): Promise<number> {
  const label = repoLabel(args.repo);
  const outDir = resolve(args.out ?? join("reports", reviewSlug(args.repo)));
  const llm = deepseekClient({ model: args.model });
  const runId = args.runId ?? newRunId(new Date());
  await initObs({ workflowName: "roster-run" });
  setSession(runId);
  try {
    const res = await withSpan("WORKFLOW", "review", { repo: label }, () =>
      runCoordinator({
        repo: args.repo,
        budgetUsd: args.budgetUsd,
        llm,
        backend: defaultBackend({ cacheDir: args.cache, dbPath: resolve(args.db), replay: { repo: args.repo } }),
        outDir,
        dbPath: resolve(args.db),
        runId,
        model: args.model,
      }),
    );
    console.log(`roster run ${label} (${res.runId}${res.resumed ? ", resumed" : ""}): ${res.outcome}`);
    console.log(res.summary);
    console.log(
      `spent $${res.spentUsd.toFixed(4)} of $${args.budgetUsd} (LLM $${res.llmUsd.toFixed(4)}, replays $${res.replayUsd.toFixed(4)}) in ${res.turns} turns`,
    );
    if (res.unpricedLlmCalls > 0) {
      console.warn(`warning: ${res.unpricedLlmCalls} LLM calls have no price in src/price; their cost is not in the total`);
    }
    console.log(`wrote ${[res.planPath, res.decisionsPath].filter(Boolean).join(", ")}`);
    return res.outcome === "promoted" || res.outcome === "no_better_setup" ? 0 : 1;
  } finally {
    await flushObs();
  }
}

export const runCommand: Command = {
  name: "run",
  summary: "run the coordinator agent: plan, replay, gate (needs DEEPSEEK_API_KEY)",
  usage: USAGE,
  async run(args) {
    let parsed: RunArgs;
    try {
      parsed = parseRunArgs(args);
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      console.error(`roster run: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    return runRun(parsed);
  },
};

if (import.meta.main) {
  process.exitCode = await runCommand.run(process.argv.slice(2));
}
