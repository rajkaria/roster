// The pull request for a promotion (DESIGN.md §"Act"). The body is rendered from the run's replay rows, and openPr
// does the opt-in check and the gh call. Nothing is opened unless the caller passes dryRun: false, and the repo
// must be in opt-ins.json (Roster's own repo root) with prAllowed.
//
//   const pr = await promotionPr({ repoPath, decision, incumbent, replays, optIns, dryRun: true });
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { type OpenPrResult, openPr, type Runner } from "../act/open-pr.ts";
import { renderPrBody, type PrBodyTask } from "../act/pr-body.ts";
import { parseRemote } from "../review/export.ts";
import { type OptIn, isAllowed, loadOptIns } from "../review/opt-in.ts";
import { loadSetups } from "../setups/registry.ts";
import type { Replay, Review } from "../types.ts";
import { resolveSetup } from "./backend.ts";
import type { Decision, ToolBackend } from "./tools.ts";

/** Roster's own repo root: where the opt-in registry lives. A reviewed repo cannot grant itself PR rights. */
export const ROSTER_ROOT = resolve(import.meta.dir, "../..");
export const OPT_INS_FILE = "opt-ins.json";

/** The registry at `path`. A missing or unreadable file allows nothing. */
export function readOptIns(path: string): OptIn[] {
  if (!existsSync(path)) return [];
  try {
    return loadOptIns(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return [];
  }
}

export interface PromotionPrOptions {
  repoPath: string;
  /** The gate's approval of the promoted candidate. */
  decision: Decision;
  /** The incumbent the candidate was gated against, as a replay setup id. */
  incumbent: string;
  /** The replay rows of the plan, both sides. */
  replays: Replay[];
  /** Gate decisions for the other candidates in the run; the rejected ones go in the body. */
  rejected?: Decision[];
  optIns: OptIn[];
  /** Build the command but never run gh. */
  dryRun?: boolean;
  /** The branch the PR is opened from. Default `roster/promote-<candidate>`. */
  branch?: string;
  run?: Runner;
}

/** Runs one command in `cwd`; a missing binary is a failed command, not a throw. */
function localRunner(cwd: string): Runner {
  return async (cmd) => {
    try {
      const proc = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr };
    } catch (err) {
      return { code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
    }
  };
}

/** One row per task both sides ran, from each side's latest attempt. Cost is the task's total across both sides. */
function tasksOf(replays: Replay[], incumbent: string, candidate: string): PrBodyTask[] {
  const latest = (setup: string, task: string) =>
    replays
      .filter((r) => r.setup_id === setup && r.task_session_id === task)
      .sort((a, b) => b.attempt - a.attempt)[0];
  const tasks = [...new Set(replays.filter((r) => r.setup_id === candidate).map((r) => r.task_session_id))]
    .filter((t) => latest(incumbent, t) !== undefined)
    .sort();
  return tasks.map((id) => {
    const inc = latest(incumbent, id);
    const cand = latest(candidate, id);
    const costs = replays.filter((r) => r.task_session_id === id && (r.setup_id === incumbent || r.setup_id === candidate));
    const priced = costs.filter((r) => r.cost_usd !== null);
    const task: PrBodyTask = {
      id,
      incumbentPass: inc?.verdict === "pass",
      candidatePass: cand?.verdict === "pass",
      costUsd: priced.length === 0 ? null : priced.reduce((s, r) => s + (r.cost_usd ?? 0), 0),
    };
    if (cand?.trace_url) task.traceUrl = cand.trace_url;
    return task;
  });
}

/**
 * Opens (or with dryRun, only builds) the PR for one promotion. The title is "Roster: promote <candidate> over
 * <incumbent>"; the body is renderPrBody over the replay rows. Never throws for a git or gh failure: that is
 * `opened: false` with the reason, from openPr.
 */
export async function promotionPr(o: PromotionPrOptions): Promise<OpenPrResult> {
  const run = o.run ?? localRunner(o.repoPath);
  const candidate = o.decision.candidate;

  let ownerRepo: string | null = null;
  try {
    const remote = await run(["git", "remote", "get-url", "origin"]);
    ownerRepo = remote.code === 0 ? parseRemote(remote.stdout) : null;
  } catch {
    ownerRepo = null;
  }

  const body = renderPrBody({
    repo: ownerRepo ?? basename(resolve(o.repoPath)),
    incumbent: o.incumbent,
    promoted: candidate,
    tasks: tasksOf(o.replays, o.incumbent, candidate),
    rejected: (o.rejected ?? [])
      .filter((d) => d.candidate !== candidate && d.verdict === "reject")
      .map((d) => ({ candidate: d.candidate, reasons: d.reasons })),
    evidenceLevel: "B",
  });

  return openPr({
    repoPath: o.repoPath,
    branch: o.branch ?? `roster/promote-${candidate}`,
    title: `Roster: promote ${candidate} over ${o.incumbent}`,
    body,
    dryRun: o.dryRun,
    allowRepo: (ownerName) => isAllowed(o.optIns, ownerName, "open-pr"),
    run,
  });
}

/** Merges the PR result into reports/<slug>/promotion.json under "pr". */
export function recordPr(reviewDir: string, pr: OpenPrResult): void {
  const path = join(reviewDir, "promotion.json");
  const doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...doc, pr }, null, 2) + "\n");
}

export interface OpenPromotionOptions {
  /** reports/<slug>, where review.json and promotion.json live. */
  reviewDir: string;
  /** A local checkout of the reviewed repo, with origin set. */
  repoPath: string;
  backend: ToolBackend;
  /** The gate decisions of the run (the coordinator's RunResult.decisions). */
  decisions: Decision[];
  dryRun: boolean;
  /** Where setups/ lives, to map the promotion's incumbent to a replay setup id. Default: the working directory. */
  setupsRoot?: string;
  optIns?: OptIn[];
  run?: Runner;
}

/**
 * After a promotion: finds the approved decision and the incumbent in promotion.json, reads the plan's replay rows
 * through the backend, opens the PR (or dry-runs it) and records the result under "pr". Null when nothing was
 * promoted.
 */
export async function openPromotion(o: OpenPromotionOptions): Promise<OpenPrResult | null> {
  const promotionPath = join(o.reviewDir, "promotion.json");
  if (!existsSync(promotionPath)) return null;
  const doc = JSON.parse(readFileSync(promotionPath, "utf8")) as { promoted: string | null; from: string | null };
  if (doc.promoted === null || doc.from === null) return null;

  const decision = o.decisions.find((d) => d.candidate === doc.promoted && d.verdict === "promote");
  if (!decision) return null;

  const reviewPath = join(o.reviewDir, "review.json");
  const review = existsSync(reviewPath) ? (JSON.parse(readFileSync(reviewPath, "utf8")) as Review) : null;
  const setups = loadSetups(o.setupsRoot ?? process.cwd(), process.env);
  const incumbent = resolveSetup(doc.from, setups, review).id;

  const replays = await o.backend.getReplayResults({ plan_id: decision.plan_id });
  const pr = await promotionPr({
    repoPath: o.repoPath,
    decision,
    incumbent,
    replays,
    rejected: o.decisions,
    optIns: o.optIns ?? readOptIns(join(ROSTER_ROOT, OPT_INS_FILE)),
    dryRun: o.dryRun,
    run: o.run,
  });
  recordPr(o.reviewDir, pr);
  return pr;
}
