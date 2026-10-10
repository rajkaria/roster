// `roster run <repo> --budget <usd>`: the coordinator agent on DeepSeek, over the tool backend
// (DESIGN.md §"Coordinator tools"). One WORKFLOW span per run; the coordinator adds AGENT and TOOL spans.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "../cli.ts";
import { deepseekClient } from "../llm/client.ts";
import { flushObs, initObs, setSession, withSpan } from "../obs/index.ts";
import { repoLabel, repoSlug, slugDir, summarizeSetups } from "../review/export.ts";
import { DEFAULT_DB, newRunId, runCoordinator } from "../agent/coordinator.ts";
import { defaultBackend } from "../agent/backend.ts";
import { ToolError, type ToolBackend } from "../agent/tools.ts";
import { fetchCheckpoints } from "../ingest/fetch.ts";
import type { Outcome, Review, Session } from "../types.ts";
import { DEFAULT_CACHE, runReview, UsageError } from "./review.ts";

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

export interface Bootstrap {
  /** "owner/name" as `roster review` resolves it (origin remote, else basename). */
  slug: string;
  /** reports/<slugDir(slug)>, where review.json lives. */
  reviewDir: string;
  /** True when this bootstrap ran the observational review. */
  reviewed: boolean;
}

export interface BootstrapOptions {
  cacheDir?: string;
  reportsDir?: string;
  /** Runs the observational review. Default: `roster review --observational`'s runReview. */
  review?: (repo: string, outDir: string, cacheDir: string) => Promise<number>;
  log?: (msg: string) => void;
}

/** Commit time (ms) of the newest Entire checkpoint in a fetched repo, or null when there is none. */
function newestCheckpointMs(repoPath: string, backend: "branch" | "refs"): number | null {
  const args =
    backend === "branch"
      ? ["log", "-1", "--format=%ct", "entire/checkpoints/v1"]
      : ["for-each-ref", "--sort=-committerdate", "--count=1", "--format=%(committerdate:unix)", "refs/entire/checkpoints/"];
  const p = Bun.spawnSync(["git", ...args], { cwd: repoPath, stdout: "pipe", stderr: "pipe" });
  const s = Number(p.stdout.toString().trim());
  return p.exitCode === 0 && s > 0 ? s * 1000 : null;
}

/**
 * Finds the repo's observational review the way `roster review` names it, and runs that review first when
 * reports/<slug>/review.json is missing or older than the newest checkpoint. A failed review is logged, not thrown:
 * get_scorecard then reports the missing review to the coordinator.
 */
export async function bootstrapReview(repo: string, opts: BootstrapOptions = {}): Promise<Bootstrap> {
  const cacheDir = resolve(opts.cacheDir ?? DEFAULT_CACHE);
  const log = opts.log ?? ((m: string) => console.log(m));
  const slug = repoSlug(repo);
  const reviewDir = resolve(opts.reportsDir ?? "reports", slugDir(slug));
  const reviewPath = join(reviewDir, "review.json");

  let stale = true;
  if (existsSync(reviewPath)) {
    const review = JSON.parse(readFileSync(reviewPath, "utf8")) as Partial<Review>;
    const writtenMs = Date.parse(review.generated_at ?? review.created_at ?? "");
    const f = await fetchCheckpoints(repo, { cacheDir });
    const newest = f.backend === "none" ? null : newestCheckpointMs(f.repoPath, f.backend);
    stale = Number.isNaN(writtenMs) || (newest !== null && newest > writtenMs);
  }
  if (!stale) return { slug, reviewDir, reviewed: false };

  log(`roster run: no current review at ${reviewDir}; running the observational review first`);
  const review = opts.review ?? ((r, out, cache) => runReview({ repo: r, out, cache }));
  const code = await review(repo, reviewDir, cacheDir);
  if (code !== 0) log(`roster run: the observational review exited ${code}; get_scorecard will have no review`);
  return { slug, reviewDir, reviewed: code === 0 };
}

/** The backend with get_scorecard reading the review from `reviewDir` (the bootstrap's slug dir). */
export function scorecardAt(backend: ToolBackend, reviewDir: string): ToolBackend {
  const read = <T>(file: string): T | null => {
    const p = join(reviewDir, file);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
  };
  return {
    ...backend,
    async getScorecard({ repo }) {
      const review = read<Review>("review.json");
      if (!review) throw new ToolError(`no review in ${reviewDir}; run \`roster review ${repo} --observational\` first`);
      return { review, setups: summarizeSetups(read<Session[]>("sessions.json") ?? [], read<Outcome[]>("outcomes.json") ?? []) };
    },
  };
}

/** Runs the coordinator. Exit 0 when it promoted or honestly found no better setup, 1 otherwise. */
export async function runRun(args: RunArgs): Promise<number> {
  const label = repoLabel(args.repo);
  const llm = deepseekClient({ model: args.model });
  const boot = await bootstrapReview(args.repo, { cacheDir: args.cache });
  const outDir = resolve(args.out ?? boot.reviewDir);
  const runId = args.runId ?? newRunId(new Date());
  await initObs({ workflowName: "roster-run" });
  setSession(runId);
  try {
    const res = await withSpan("WORKFLOW", "review", { repo: label }, () =>
      runCoordinator({
        repo: args.repo,
        budgetUsd: args.budgetUsd,
        llm,
        backend: scorecardAt(defaultBackend({ cacheDir: args.cache, dbPath: resolve(args.db), replay: { repo: args.repo } }), boot.reviewDir),
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
