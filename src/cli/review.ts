// `roster review <repo> --observational`: fetch → parse → identify → score, then reports/<slug>/.
// Every stage is a TOOL span inside one WORKFLOW review span (DESIGN.md §"Observability (neatlogs)"). The
// review ends with one line of wall time per stage.
import { join, resolve } from "node:path";
import type { Command } from "../cli.ts";
import { priceSession } from "../price/index.ts";
import { flushObs, initObs, setSession, withSpan } from "../obs/index.ts";
import { ATTR, summaryAttr } from "../obs/attributes.ts";
import { fetchCheckpoints } from "../ingest/fetch.ts";
import { type ParsedSession, parseCheckpoints } from "../ingest/parse.ts";
import { type Identity, identify, inferenceAccuracy } from "../identity/index.ts";
import { survival, survivalMany } from "../score/survival.ts";
import { isReverted, reverted } from "../score/revert.ts";
import { BUDGET_MESSAGE, gitFailure, gitPool, type GitResult, type GitRunner, rework, reworkShares, trackMany } from "../score/rework.ts";
import { buildSetupRows, buildTags, repoSlug, type ReviewReport, slugDir, writeReview } from "../review/export.ts";
import type { Outcome, Review, Session } from "../types.ts";

export const DEFAULT_CACHE = ".roster/cache";
/** Mature = at least this many first-parent commits after the session's commit, and this many seconds older than HEAD. */
export const MIN_DEPTH = 5;
export const MIN_AGE_S = 6 * 3600;

const STAGES = ["fetch", "parse", "identify", "score"] as const;
type Stage = (typeof STAGES)[number];

const USAGE = `usage: roster review <repo> --observational [--out <dir>] [--cache <dir>]

  <repo>            a git URL or a local path to a repo that has Entire checkpoints
  --observational   score sessions that already exist (evidence level A). Required for now.
  --out <dir>       where to write review.json, review.md, sessions.json and outcomes.json
                    (default reports/<slug>)
  --cache <dir>     fetch cache (default ${DEFAULT_CACHE})`;

export interface ReviewArgs {
  repo: string;
  out: string | undefined;
  cache: string;
}

/** Thrown for bad arguments. The CLI prints the message and exits 2. */
export class UsageError extends Error {}

/** Parses the arguments after `review`. Throws UsageError on anything it does not accept. */
export function parseReviewArgs(args: string[]): ReviewArgs {
  let repo: string | undefined;
  let observational = false;
  let out: string | undefined;
  let cache = DEFAULT_CACHE;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);
    // A flag takes its value inline (--out=dir) or as the next argument (--out dir).
    const takeValue = (): string => {
      if (eq !== -1) return a.slice(eq + 1);
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${name} needs a value`);
      return v;
    };
    if (name === "--observational" && eq === -1) observational = true;
    else if (name === "--out") out = takeValue();
    else if (name === "--cache") cache = takeValue();
    else if (a.startsWith("-")) throw new UsageError(`unknown flag ${a}`);
    else if (repo === undefined) repo = a;
    else throw new UsageError(`unexpected argument ${a}`);
  }
  if (repo === undefined) throw new UsageError("missing <repo>");
  if (!observational) {
    throw new UsageError("only --observational is implemented; the controlled replay path is not built yet");
  }
  return { repo, out, cache };
}

const NO_DATA =
  "no Entire data found. Run `entire enable` in the source repo, push its entire/checkpoints/v1 branch, and try again.";

function git(repo: string, args: string[]): string {
  const p = Bun.spawnSync(["git", "-c", "core.quotepath=off", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${p.stderr.toString().trim()}`);
  return p.stdout.toString();
}

/** Wall time the whole scoring pass may take before the remaining sessions are marked not scored. */
export const SCORE_BUDGET_MS = 120_000;
const PROGRESS_EVERY = 10;

export interface ScoreOptions {
  budgetMs?: number;
  /** Called with a line like `score: 10/50 sessions, 12.3 s` at every 10th session. */
  onProgress?: (line: string) => void;
}

interface ScoreContext {
  repo: string;
  head: string;
  headTime: number;
}

/** One user prompt means nobody steered the session. Needs no commit age; null when the count is unknown. */
const isUnattended = (s: ParsedSession): boolean | null => (Number.isFinite(s.n_user_prompts) ? s.n_user_prompts === 1 : null);

const tooYoung = (session_id: string, unattended: boolean | null = null): Outcome => ({
  session_id,
  status: "too_young",
  survival: null,
  reverted: null,
  rework_human: null,
  rework_agent: null,
  unattended,
  tests_at_commit: null,
  difficulty: null,
  tercile: null,
});

/**
 * Scores one session from its commit. Sessions without a trailer-linked commit, and commits that are not yet
 * mature, come back too_young with null metrics. Throws when git cannot read the commit.
 */
export function scoreSession(session: ParsedSession, ctx: ScoreContext): Outcome {
  const sha = session.commit_sha;
  if (sha === null) return tooYoung(session.id, isUnattended(session));
  const depth = Number(git(ctx.repo, ["rev-list", "--count", "--first-parent", `${sha}..${ctx.head}`]).trim());
  const age = ctx.headTime - Number(git(ctx.repo, ["show", "-s", "--format=%ct", sha]).trim());
  if (depth < MIN_DEPTH || age < MIN_AGE_S) return tooYoung(session.id, isUnattended(session));

  const surv = survival(ctx.repo, [sha], ctx.head);
  const rw = rework(ctx.repo, sha);
  return {
    session_id: session.id,
    status: "mature",
    survival: surv.ratio,
    reverted: reverted(ctx.repo, sha),
    rework_human: rw.human,
    rework_agent: rw.agent,
    unattended: isUnattended(session),
    tests_at_commit: null,
    difficulty: null,
    tercile: null,
  };
}

/**
 * scoreSession for every session at once, with the same outcomes. Git work goes through `run` (a pool
 * of GIT_PARALLEL processes by default): blame runs once per (file, HEAD) and rework and reverts share
 * one history pass. Each entry is the session's Outcome, or the Error that stopped it.
 */
export async function scoreAll(
  sessions: ParsedSession[],
  ctx: ScoreContext,
  inner: GitRunner = gitPool(),
  opts: ScoreOptions = {},
): Promise<(Outcome | Error)[]> {
  const started = performance.now();
  const budgetMs = opts.budgetMs ?? SCORE_BUDGET_MS;
  // Past the budget every git call is refused, so the sessions still waiting come back not scored.
  const run: GitRunner = (repo, args, stdin) => {
    const left = budgetMs - (performance.now() - started);
    const refused: GitResult = { ok: false, out: "", err: BUDGET_MESSAGE, budget: true };
    if (left <= 0) return Promise.resolve(refused);
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<GitResult>((done) => (timer = setTimeout(() => done(refused), left)));
    return Promise.race([inner(repo, args, stdin), expired]).finally(() => clearTimeout(timer));
  };
  const out = async (args: string[]) => {
    const r = await run(ctx.repo, ["-c", "core.quotepath=off", ...args]);
    if (!r.ok) throw gitFailure(r, `git ${args[0]}`);
    return r.out;
  };
  const asError = (err: unknown) => (err instanceof Error ? err : new Error(String(err)));

  // Maturity: the same two questions scoreSession asks, all sessions in parallel.
  const maturity = await Promise.all(
    sessions.map(async (s): Promise<string | null | Outcome | Error> => {
      const sha = s.commit_sha;
      if (sha === null) return tooYoung(s.id, isUnattended(s));
      const [depthR, showR] = await Promise.allSettled([
        out(["rev-list", "--count", "--first-parent", `${sha}..${ctx.head}`]),
        out(["show", "-s", "--format=%H %ct", sha]),
      ]);
      if (depthR.status === "rejected") return asError(depthR.reason);
      if (showR.status === "rejected") return asError(showR.reason);
      const [full = "", time = ""] = showR.value.trim().split(" ");
      const depth = Number(depthR.value.trim());
      if (depth < MIN_DEPTH || ctx.headTime - Number(time) < MIN_AGE_S) return tooYoung(s.id, isUnattended(s));
      return full;
    }),
  );

  const mature = [...new Set(maturity.filter((m): m is string => typeof m === "string"))];
  let head: string | Error;
  try {
    head = (await out(["rev-parse", "--verify", `${ctx.head}^{commit}`])).trim();
  } catch {
    head = new Error(`cannot resolve ${ctx.head} in ${ctx.repo}`);
  }
  // Progress counts sessions: those already settled (too young, no commit, failed) plus each mature
  // commit's sessions as its survival lands. A line goes out at every 10th.
  const sessionsOf = new Map<string, number>();
  maturity.forEach((m) => typeof m === "string" && sessionsOf.set(m, (sessionsOf.get(m) ?? 0) + 1));
  let done = sessions.length - [...sessionsOf.values()].reduce((a, b) => a + b, 0);
  let reported = 0;
  const advance = (n: number) => {
    done += n;
    for (; (reported + 1) * PROGRESS_EVERY <= done; reported++) {
      const secs = ((performance.now() - started) / 1000).toFixed(1);
      opts.onProgress?.(`score: ${(reported + 1) * PROGRESS_EVERY}/${sessions.length} sessions, ${secs} s`);
    }
  };
  advance(0);
  const failAll = (err: unknown) => new Map(mature.map((sha) => [sha, asError(err)] as const));
  const [surv, tracked] = await Promise.all([
    typeof head === "string"
      ? survivalMany(ctx.repo, mature.map((sha) => [sha]), head, run, new Map(), (i) => advance(sessionsOf.get(mature[i]!) ?? 0))
      : mature.map(() => head as Error),
    trackMany(ctx.repo, mature, run).catch(failAll),
  ]);
  const survOf = new Map(mature.map((sha, i) => [sha, surv[i]!]));

  return sessions.map((s, i) => {
    const m = maturity[i]!;
    if (typeof m !== "string") return m;
    const sv = survOf.get(m)!;
    if (sv instanceof Error) return sv;
    const t = tracked.get(m) ?? new Error(`no history for ${m}`);
    if (t instanceof Error) return t;
    const rw = reworkShares(t);
    return {
      session_id: s.id,
      status: "mature",
      survival: sv.ratio,
      reverted: isReverted(t),
      rework_human: rw.human,
      rework_agent: rw.agent,
      unattended: isUnattended(s),
      tests_at_commit: null,
      difficulty: null,
      tercile: null,
    };
  });
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

/** Wall time per stage, in ms. */
type Timings = Map<string, number>;

/** Timed stages in print order. `difficulty` is not part of this command yet, so it prints as not run. */
const TIMED = ["fetch", "parse", "identify", "score", "difficulty", "export"] as const;

export function formatTimings(times: Timings, totalMs: number): string {
  const s = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
  const parts = TIMED.map((name) => {
    const ms = times.get(name);
    return `${name} ${ms === undefined ? "not run" : s(ms)}`;
  });
  return `time: ${parts.join(" · ")} · total ${s(totalMs)}`;
}

async function timed<T>(times: Timings, name: string, work: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await work();
  } finally {
    times.set(name, performance.now() - t0);
  }
}

async function stage<T>(times: Timings, n: number, name: Stage, repo: string, work: () => Promise<[T, string]>): Promise<T> {
  return timed(times, name, () =>
    withSpan("TOOL", name, { repo }, async () => {
      const [value, detail] = await work();
      console.log(`[${n}/${STAGES.length}] ${name}: ${detail}`);
      return value;
    }),
  );
}

/** Runs the whole review. Resolves to the exit code; writes reports only when every stage succeeds. */
export async function runReview(args: ReviewArgs): Promise<number> {
  const label = repoSlug(args.repo);
  const outDir = resolve(args.out ?? join("reports", slugDir(label)));
  const createdAt = new Date().toISOString();
  const reviewId = `${slugDir(label)}-${createdAt.replace(/\D/g, "").slice(0, 14)}`;

  await initObs({ workflowName: "roster-review" });
  setSession(reviewId);
  console.log(`roster review ${label} (${reviewId}) → ${outDir}`);
  const times: Timings = new Map();
  const t0 = performance.now();
  try {
    // One span per stage, never one per session: session-level detail goes into one roster.summary count line.
    return await withSpan("WORKFLOW", "review", { repo: label }, async (root) => {
      const fetched = await stage(times, 1, "fetch", label, async () => {
        const f = await fetchCheckpoints(args.repo, { cacheDir: resolve(args.cache) });
        return [f, `backend=${f.backend} head=${f.headSha.slice(0, 12) || "none"}`];
      });
      if (fetched.backend === "none") {
        console.error(`roster review: ${NO_DATA}`);
        return 1;
      }
      if (fetched.headSha === "") {
        console.error("roster review: the repo has checkpoints but no HEAD commit to score them against");
        return 1;
      }

      const sessions = await stage(times, 2, "parse", label, async () => {
        const parsed = parseCheckpoints(fetched.repoPath, fetched.backend === "refs" ? "git-refs" : "branch");
        return [parsed, `${parsed.length} sessions`];
      });

      const identities: Identity[] = await stage(times, 3, "identify", label, async () => {
        const ids = sessions.map((s) => identify(s, fetched.repoPath));
        const setups = new Set(ids.map((i) => i.setupId).filter((x): x is string => x !== null)).size;
        const acc = inferenceAccuracy(ids);
        return [ids, `${setups} setups, tag accuracy ${acc === null ? "n/a (no tagged sessions)" : pct(acc)}`];
      });

      const headTime = Number(git(fetched.repoPath, ["show", "-s", "--format=%ct", fetched.headSha]).trim());
      const ctx: ScoreContext = { repo: fetched.repoPath, head: fetched.headSha, headTime };
      const scored = await stage(times, 4, "score", label, async () => {
        const out: Session[] = [];
        const outcomes: Outcome[] = [];
        const failed: string[] = [];
        const scoredAll = await scoreAll(sessions, ctx, undefined, { onProgress: (l) => console.log(l) });
        sessions.forEach((s, i) => {
          const id = identities[i]!;
          const cost = priceSession(s.model, {
            input: s.tokens_in,
            output: s.tokens_out,
            cache_read: s.cache_read,
            cache_write: s.cache_write,
          }).usd;
          out.push({ ...stripParsed(s), setup_id: id.setupId, cost_usd: cost });
          const o = scoredAll[i]!;
          if (o instanceof Error) {
            failed.push(`${s.id}: ${o.message}`);
            outcomes.push(tooYoung(s.id, isUnattended(s)));
          } else outcomes.push(o);
        });
        const mature = outcomes.filter((o) => o.status === "mature").length;
        return [
          { out, outcomes, failed },
          `${mature} mature, ${outcomes.length - mature} too young${failed.length ? `, ${failed.length} failed` : ""}`,
        ];
      });

      root.setAttribute(
        ATTR.summary,
        summaryAttr({
          sessions: sessions.length,
          mature: scored.outcomes.filter((o) => o.status === "mature").length,
          too_young: scored.outcomes.filter((o) => o.status === "too_young").length,
          failed: scored.failed.length,
          setups: new Set(identities.map((i) => i.setupId).filter((x) => x !== null)).size,
          unpriced: scored.out.filter((s) => s.cost_usd === null).length,
        }),
      );

      const notes = [
        `${scored.outcomes.filter((o) => o.status === "too_young").length} sessions are too young or have no commit: a session is mature at ≥ ${MIN_DEPTH} first-parent commits and ≥ ${MIN_AGE_S / 3600} h before HEAD`,
        ...scored.failed.map((f) => `could not be scored: ${f}`),
        `${scored.out.filter((s) => s.cost_usd === null).length} sessions have no price (unknown model, or a price that depends on prompt size)`,
        `${scored.out.filter((s) => s.setup_id === null).length} sessions have no setup because their rules hash is unknown`,
      ];
      const tags = buildTags(scored.out);
      const review: Review = {
        id: reviewId,
        repo: label,
        created_at: createdAt,
        generated_at: createdAt,
        has_entire_data: true,
        setups: buildSetupRows(scored.out, scored.outcomes),
        ...(tags ? { tags } : {}),
        label: "insufficient_data",
        suspect: null,
        odds_ratio: null,
        ci95: null,
        p_value: null,
        evidence_level: "A",
      };
      const report: ReviewReport = {
        review,
        note:
          "No suspect call. The difficulty-matched Mantel–Haenszel test (DESIGN.md §\"Difficulty and review\") is not part of this command yet, so the setup numbers below are descriptive only.",
        sessions: scored.out,
        outcomes: scored.outcomes,
        notes,
      };
      const written = await timed(times, "export", async () => writeReview(outDir, report));
      console.log(`wrote ${written.join(", ")}`);
      console.log(`label ${review.label} · evidence level ${review.evidence_level}`);
      return 0;
    });
  } finally {
    if (times.size > 0) console.log(formatTimings(times, performance.now() - t0));
    await flushObs();
  }
}

/** A ParsedSession without the parse-only fields, so sessions.json holds Session rows. */
function stripParsed(s: ParsedSession): Session {
  const { usage_source: _usage, model_source: _model, ...session } = s;
  return session;
}

export const reviewCommand: Command = {
  name: "review",
  summary: "score a repo's agent sessions (--observational)",
  usage: USAGE,
  async run(args) {
    let parsed: ReviewArgs;
    try {
      parsed = parseReviewArgs(args);
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      console.error(`roster review: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    return runReview(parsed);
  },
};
