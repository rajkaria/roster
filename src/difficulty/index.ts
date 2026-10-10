// Per-session difficulty (DESIGN.md §"Difficulty and review"): the mean z-score, over the sessions
// being compared, of log(1 + lines changed), files touched, graph impact size and first-prompt
// length. Terciles split the sessions by that score so setups are compared like for like.

import type { Session, Tercile } from "../types.ts";
import { gitPool, type GitRunner } from "../score/rework.ts";
import { GraphQueue, impactSize, impactSizes, type GraphOptions, type ImpactFallback, type ImpactMethod } from "./graph.ts";

export type { ImpactFallback, ImpactMethod } from "./graph.ts";

export interface DifficultyFeatures {
  /** Added + deleted lines in the session's commit; null when the session has no commit. */
  lines_changed: number | null;
  files_touched: number;
  impact: number;
  /** Which impact method produced `impact`. */
  impact_method: ImpactMethod;
  /** Set by reviewDifficulty: why the graph was asked but fan-in used (null when it was not). */
  impact_fallback?: ImpactFallback | null;
  first_prompt_len: number;
}

export interface DifficultyScore {
  session_id: string;
  features: DifficultyFeatures;
  difficulty: number;
  tercile: Tercile;
}

function git(repo: string, args: string[]): { ok: boolean; out: string } {
  const p = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString() };
}

/** Lines and files changed by `sha` (binary files count as one file, zero lines). */
export function commitChange(repo: string, sha: string): { lines: number; files: string[] } | null {
  return parseNumstat(git(repo, [...NUMSTAT, sha]));
}

const NUMSTAT = ["show", "--numstat", "--format=", "--no-renames"];

function parseNumstat(r: { ok: boolean; out: string }): { lines: number; files: string[] } | null {
  if (!r.ok) return null;
  let lines = 0;
  const files: string[] = [];
  for (const row of r.out.split("\n")) {
    const [add, del, path] = row.split("\t");
    if (path === undefined) continue;
    files.push(path);
    lines += (Number(add) || 0) + (Number(del) || 0);
  }
  return { lines, files };
}

/** Raw difficulty features of one session. */
export function features(session: Session, repo: string, opts: GraphOptions = {}): DifficultyFeatures {
  const change = session.commit_sha ? commitChange(repo, session.commit_sha) : null;
  const files = session.files.length > 0 ? session.files : change?.files ?? [];
  const impact = impactSize(repo, change ? session.commit_sha : null, files, opts);
  return {
    lines_changed: change?.lines ?? null,
    files_touched: files.length,
    impact: impact.size,
    impact_method: impact.method,
    first_prompt_len: session.first_prompt.length,
  };
}

/** z-scores of `xs`; missing values and zero-variance columns score 0 (the mean). */
export function zScores(xs: (number | null)[]): number[] {
  const present = xs.filter((x): x is number => x !== null);
  if (present.length === 0) return xs.map(() => 0);
  const mean = present.reduce((s, x) => s + x, 0) / present.length;
  const sd = Math.sqrt(present.reduce((s, x) => s + (x - mean) ** 2, 0) / present.length);
  return xs.map((x) => (x === null || sd === 0 ? 0 : (x - mean) / sd));
}

/** Mean z-score of the four features, per row, relative to all rows given. */
export function difficultyFromFeatures(rows: DifficultyFeatures[]): number[] {
  const cols = [
    zScores(rows.map((f) => (f.lines_changed === null ? null : Math.log1p(f.lines_changed)))),
    zScores(rows.map((f) => f.files_touched)),
    zScores(rows.map((f) => f.impact)),
    zScores(rows.map((f) => f.first_prompt_len)),
  ];
  return rows.map((_, i) => cols.reduce((s, c) => s + c[i]!, 0) / cols.length);
}

/**
 * Terciles by rank: the lowest third of scores is 1, the highest third 3. Ties break by id so the
 * split is deterministic.
 */
export function terciles<T extends { session_id: string; difficulty: number }>(rows: T[]): Map<string, Tercile> {
  const sorted = [...rows].sort(
    (a, b) => a.difficulty - b.difficulty || (a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0),
  );
  const out = new Map<string, Tercile>();
  sorted.forEach((r, i) => out.set(r.session_id, (Math.floor((3 * i) / sorted.length) + 1) as Tercile));
  return out;
}

/** Difficulty and tercile of every session, scored against the others in `sessions`. */
export function difficulty(sessions: Session[], repo: string, opts: GraphOptions = {}): DifficultyScore[] {
  return scoreFeatures(sessions, sessions.map((s) => features(s, repo, opts)));
}

export interface ReviewDifficultyOptions extends GraphOptions {
  /** Git runner; default a pool of GIT_PARALLEL processes. */
  run?: GitRunner;
  /** Concurrent graph calls; default GRAPH_PARALLEL. */
  concurrency?: number;
}

/**
 * `difficulty` for a whole review, with bounded graph calls: at most one per touched file in the
 * review, GRAPH_PARALLEL at once, REVIEW_TIMEOUT_MS each, every symbol asked once. A session whose
 * graph call times out, fails or exceeds the budget uses fan-in, and `impact_fallback` says why.
 */
export async function reviewDifficulty(
  sessions: Session[],
  repo: string,
  opts: ReviewDifficultyOptions = {},
): Promise<{ scores: DifficultyScore[]; queue: GraphQueue }> {
  const run = opts.run ?? gitPool();
  const changes = await Promise.all(
    sessions.map(async (s) => (s.commit_sha ? parseNumstat(await run(repo, [...NUMSTAT, s.commit_sha])) : null)),
  );
  const touched = sessions.map((s, i) => (s.files.length > 0 ? s.files : changes[i]?.files ?? []));
  const queue = new GraphQueue(repo, { ...opts, maxCalls: new Set(touched.flat()).size });
  const impacts = await impactSizes(
    queue,
    run,
    sessions.map((s, i) => ({ sha: changes[i] ? s.commit_sha : null, files: touched[i]! })),
    opts.maxSymbols,
  );
  const feats = sessions.map(
    (s, i): DifficultyFeatures => ({
      lines_changed: changes[i]?.lines ?? null,
      files_touched: touched[i]!.length,
      impact: impacts[i]!.size,
      impact_method: impacts[i]!.method,
      impact_fallback: impacts[i]!.fallback,
      first_prompt_len: s.first_prompt.length,
    }),
  );
  return { scores: scoreFeatures(sessions, feats), queue };
}

function scoreFeatures(sessions: Session[], feats: DifficultyFeatures[]): DifficultyScore[] {
  const scores = difficultyFromFeatures(feats);
  const rows = sessions.map((s, i) => ({ session_id: s.id, features: feats[i]!, difficulty: scores[i]! }));
  const t = terciles(rows);
  return rows.map((r) => ({ ...r, tercile: t.get(r.session_id)! }));
}
