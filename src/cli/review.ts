// `roster review <repo> --observational`: fetch → parse → identify → score, then reports/<slug>/.
// Every stage is a TOOL span inside one WORKFLOW review span (DESIGN.md §"Observability (neatlogs)").
import { join, resolve } from "node:path";
import type { Command } from "../cli.ts";
import { priceSession } from "../price/index.ts";
import { flushObs, initObs, setSession, withSpan } from "../obs/index.ts";
import { fetchCheckpoints } from "../ingest/fetch.ts";
import { type ParsedSession, parseCheckpoints } from "../ingest/parse.ts";
import { type Identity, identify, inferenceAccuracy } from "../identity/index.ts";
import { survival } from "../score/survival.ts";
import { reverted } from "../score/revert.ts";
import { rework } from "../score/rework.ts";
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

interface ScoreContext {
  repo: string;
  head: string;
  headTime: number;
}

const tooYoung = (session_id: string): Outcome => ({
  session_id,
  status: "too_young",
  survival: null,
  reverted: null,
  rework_human: null,
  rework_agent: null,
  unattended: null,
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
  if (sha === null) return tooYoung(session.id);
  const depth = Number(git(ctx.repo, ["rev-list", "--count", "--first-parent", `${sha}..${ctx.head}`]).trim());
  const age = ctx.headTime - Number(git(ctx.repo, ["show", "-s", "--format=%ct", sha]).trim());
  if (depth < MIN_DEPTH || age < MIN_AGE_S) return tooYoung(session.id);

  const surv = survival(ctx.repo, [sha], ctx.head);
  const rw = rework(ctx.repo, sha);
  return {
    session_id: session.id,
    status: "mature",
    survival: surv.ratio,
    reverted: reverted(ctx.repo, sha),
    rework_human: rw.human,
    rework_agent: rw.agent,
    unattended: session.n_user_prompts === 1,
    tests_at_commit: null,
    difficulty: null,
    tercile: null,
  };
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

async function stage<T>(n: number, name: Stage, repo: string, work: () => Promise<[T, string]>): Promise<T> {
  return withSpan("TOOL", name, { repo }, async () => {
    const [value, detail] = await work();
    console.log(`[${n}/${STAGES.length}] ${name}: ${detail}`);
    return value;
  });
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
  try {
    return await withSpan("WORKFLOW", "review", { repo: label }, async () => {
      const fetched = await stage(1, "fetch", label, async () => {
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

      const sessions = await stage(2, "parse", label, async () => {
        const parsed = parseCheckpoints(fetched.repoPath, fetched.backend === "refs" ? "git-refs" : "branch");
        return [parsed, `${parsed.length} sessions`];
      });

      const identities: Identity[] = await stage(3, "identify", label, async () => {
        const ids = sessions.map((s) => identify(s, fetched.repoPath));
        const setups = new Set(ids.map((i) => i.setupId).filter((x): x is string => x !== null)).size;
        const acc = inferenceAccuracy(ids);
        return [ids, `${setups} setups, tag accuracy ${acc === null ? "n/a (no tagged sessions)" : pct(acc)}`];
      });

      const headTime = Number(git(fetched.repoPath, ["show", "-s", "--format=%ct", fetched.headSha]).trim());
      const ctx: ScoreContext = { repo: fetched.repoPath, head: fetched.headSha, headTime };
      const scored = await stage(4, "score", label, async () => {
        const out: Session[] = [];
        const outcomes: Outcome[] = [];
        const failed: string[] = [];
        sessions.forEach((s, i) => {
          const id = identities[i]!;
          const cost = priceSession(s.model, {
            input: s.tokens_in,
            output: s.tokens_out,
            cache_read: s.cache_read,
            cache_write: s.cache_write,
          }).usd;
          out.push({ ...stripParsed(s), setup_id: id.setupId, cost_usd: cost });
          try {
            outcomes.push(scoreSession(s, ctx));
          } catch (err) {
            failed.push(`${s.id}: ${err instanceof Error ? err.message : String(err)}`);
            outcomes.push(tooYoung(s.id));
          }
        });
        const mature = outcomes.filter((o) => o.status === "mature").length;
        return [
          { out, outcomes, failed },
          `${mature} mature, ${outcomes.length - mature} too young${failed.length ? `, ${failed.length} failed` : ""}`,
        ];
      });

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
      const written = writeReview(outDir, report);
      console.log(`wrote ${written.join(", ")}`);
      console.log(`label ${review.label} · evidence level ${review.evidence_level}`);
      return 0;
    });
  } finally {
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
