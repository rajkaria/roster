// The coordinator's real tool backend (DESIGN.md §"Coordinator tools"). Each method adapts a module that exists:
// ingest and the review's scorecard, replayable tasks from the repo's checkpoints, replays through src/replay/run.ts,
// failure codes from src/grade/taxonomy.ts, the deterministic gate in src/gate, and the promotion record in
// reports/<slug>/promotion.json. Opening a pull request is a separate command and is not done here.
//
// Replay rows live in memory for the run and in the state database when one is given (table `replays`), so a
// resumed run reads back what the earlier process produced.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { identify, setupIdOf } from "../identity/index.ts";
import { fetchCheckpoints } from "../ingest/fetch.ts";
import { parseCheckpoints } from "../ingest/parse.ts";
import { discordant, gate as decideGate, MAX_ATTEMPTS } from "../gate/index.ts";
import type { GradeResult } from "../grade/index.ts";
import { type Classified, classify, parseTranscript, type Transcript } from "../grade/taxonomy.ts";
import { reviewSlug, summarizeSetups } from "../review/export.ts";
import { defaultWorkRoot, replayRunner, runReplays, type ReplayRunnerDeps, type SkippedRun } from "../replay/run.ts";
import { buildReplayTasks, type ReplayTask } from "../replay/tasks.ts";
import { loadSetups, type RunnableSetup } from "../setups/registry.ts";
import { runGit } from "../sandbox/index.ts";
import { FailureCode, type Outcome, type Replay, type Review, type Session } from "../types.ts";
import { NotAvailableError, type ReplayBatch, type TaskSummary, type ToolBackend, ToolError } from "./tools.ts";

export interface DefaultBackendOptions {
  cacheDir?: string;
  /** Where review files and promotion.json go. Default "reports". */
  reportsDir?: string;
  /** The coordinator's state database. Replay rows are written here too when given. */
  dbPath?: string;
  /** What the replay runner needs: the repo under review, plus optional overrides (setups root, work root, harness). */
  replay?: Omit<ReplayRunnerDeps, "cacheDir">;
}

const BRANCH_REFS = ["refs/heads/entire/checkpoints/v1", "refs/remotes/origin/entire/checkpoints/v1"];
const REMOTE = /^[a-z][a-z0-9+.-]*:\/\/|^[^/\s]+@[^/\s]+:/i;
const FAILURE_ORDER: string[] = Object.values(FailureCode);

function tryGit(repo: string, args: string[]): string | null {
  try {
    return runGit(repo, args);
  } catch {
    return null;
  }
}

/** Session turn counts from the checkpoint metadata on the branch (`session_metrics.turn_count`); null when absent. */
function turnCounter(repo: string): (checkpointId: string, sessionId: string) => number | null {
  const ref = BRANCH_REFS.find((r) => tryGit(repo, ["rev-parse", "--verify", "-q", r]) !== null);
  const show = (path: string): any => {
    const out = ref ? tryGit(repo, ["show", `${ref}:${path}`]) : null;
    try {
      return out === null ? null : JSON.parse(out);
    } catch {
      return null;
    }
  };
  return (checkpointId, sessionId) => {
    const dir = `${checkpointId.slice(0, 2)}/${checkpointId.slice(2)}`;
    const root = show(`${dir}/metadata.json`);
    const n = Array.isArray(root?.sessions) ? root.sessions.length : 0;
    for (let i = 0; i < n; i++) {
      const meta = show(`${dir}/${i}/metadata.json`);
      if (meta?.session_id === sessionId) {
        const turns = meta.session_metrics?.turn_count;
        return typeof turns === "number" ? turns : null;
      }
    }
    return null;
  };
}

interface RepoTasks {
  repoPath: string;
  sessions: Session[];
  tasks: ReplayTask[];
}

/** The repo's checkpoints as replayable tasks, resolved the way the replay runner resolves them. */
async function loadRepo(repo: string, cacheDir: string, outcomes: Outcome[]): Promise<RepoTasks> {
  if (!REMOTE.test(repo) && !existsSync(resolve(repo))) throw new Error(`no such repo: ${repo}`);
  const f = await fetchCheckpoints(repo, { cacheDir });
  if (f.backend === "none") throw new Error("no Entire checkpoints found in this repo");
  const sessions: Session[] = parseCheckpoints(f.repoPath, f.backend === "refs" ? "git-refs" : "branch").map((s) => ({
    ...s,
    setup_id: identify(s, f.repoPath).setupId,
  }));
  return { repoPath: f.repoPath, sessions, tasks: buildReplayTasks(f.repoPath, sessions, outcomes) };
}

const TERCILE_ORDER = [1, 2, 3, null] as const;
const TRACK_ORDER: TaskSummary["track"][] = ["tests", "judge-only"];

/** FNV-1a, 32 bits: a stable hash, so the sample depends only on the seed and the task ids. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The simple sampler: tests track first, then judge-only (never "none"); round-robin across terciles; within a
 * tercile, the order is a hash of the seed and the task id. The same inputs always give the same ids.
 */
export function simpleSample(tasks: TaskSummary[], max: number, exclude: readonly string[], seed: string): string[] {
  const skip = new Set(exclude);
  const picked: string[] = [];
  for (const track of TRACK_ORDER) {
    const buckets = TERCILE_ORDER.map((tercile) =>
      tasks
        .filter((t) => t.track === track && t.tercile === tercile && !skip.has(t.id))
        .sort((a, b) => hash32(seed + a.id) - hash32(seed + b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    );
    let progressed = true;
    while (picked.length < max && progressed) {
      progressed = false;
      for (const bucket of buckets) {
        if (picked.length === max) break;
        const next = bucket.shift();
        if (next) {
          picked.push(next.id);
          progressed = true;
        }
      }
    }
    if (picked.length === max) break;
  }
  return picked;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The setup id Roster infers for a definition's sessions: same harness, model and rules hash. Null when the rules file is unreadable. */
function inferredId(s: RunnableSetup): string | null {
  try {
    const texts = [s.rulesPath, ...(s.extraRulesPath ? [s.extraRulesPath] : [])].map((p) => readFileSync(p, "utf8").replace(/\r\n?/g, "\n").trim());
    return setupIdOf(s.harness, s.model, sha256(texts.join("\n")));
  } catch {
    return null;
  }
}

/**
 * Maps a coordinator-facing setup id to a runnable definition. Accepts a definition id (A–F) or a review setup id.
 * A review id goes to the definition whose tag carries it in the review's tags block (most sessions wins); without
 * a tag match, to the definition with the same harness, model and rules hash. Otherwise throws, listing the valid ids.
 */
export function resolveSetup(id: string, setups: RunnableSetup[], review: Review | null): RunnableSetup {
  const direct = setups.find((s) => s.id === id);
  if (direct) return direct;
  const tagged = Object.entries(review?.tags?.by_tag ?? {})
    .filter(([tag, v]) => v.setup_ids.includes(id) && setups.some((s) => s.id === tag))
    .sort(([, a], [, b]) => b.sessions - a.sessions);
  if (tagged.length > 0) return setups.find((s) => s.id === tagged[0]![0])!;
  const same = setups.find((s) => inferredId(s) === id);
  if (same) return same;
  throw new ToolError(`unknown setup ${id}; valid ids: ${setups.map((s) => s.id).join(", ")} (or a setup id from the review's scorecard)`);
}

/** Replay rows: memory for the run, plus the `replays` table when a database is given. */
class ReplayStore {
  private readonly rows = new Map<string, Replay>();
  private readonly db: Database | null;

  constructor(dbPath: string | undefined) {
    if (dbPath === undefined) {
      this.db = null;
      return;
    }
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS replays (
      id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, setup_id TEXT NOT NULL, json TEXT NOT NULL)`);
  }

  put(rows: Replay[]): void {
    for (const r of rows) {
      this.rows.set(r.id, r);
      this.db
        ?.query("INSERT OR REPLACE INTO replays (id, plan_id, setup_id, json) VALUES (?, ?, ?, ?)")
        .run(r.id, r.plan_id, r.setup_id, JSON.stringify(r));
    }
  }

  list(planId: string, setup?: string): Replay[] {
    const stored = this.db
      ? this.db
          .query<{ json: string }, [string, string | null, string | null]>(
            "SELECT json FROM replays WHERE plan_id = ? AND (? IS NULL OR setup_id = ?) ORDER BY rowid",
          )
          .all(planId, setup ?? null, setup ?? null)
          .map((r) => JSON.parse(r.json) as Replay)
      : [];
    const merged = new Map(stored.map((r) => [r.id, r]));
    for (const r of this.rows.values()) {
      if (r.plan_id === planId && (setup === undefined || r.setup_id === setup)) merged.set(r.id, r);
    }
    return [...merged.values()];
  }
}

/** A transcript as the replay run reads it: stream-json lines, or the one result object of --output-format json. */
function readTranscript(path: string): Transcript {
  const text = readFileSync(path, "utf8");
  const t = parseTranscript(text);
  if (t.turns > 0 || t.result !== null || !text.trim()) return t;
  try {
    const j = JSON.parse(text);
    return parseTranscript((Array.isArray(j) ? j : [j]).map((e) => JSON.stringify(e)).join("\n"));
  } catch {
    return t;
  }
}

/**
 * Failure codes for one failed replay: the taxonomy over its transcript and grade, plus the codes the run recorded.
 * The run recorded codes the taxonomy cannot re-derive here (F1 and F7 need the grader's violations, a forced code
 * needs the harness's error kind), so those keep the run's own reason.
 */
function failuresOf(r: Replay): Classified[] {
  if (r.failure_codes.includes(FailureCode.F6)) return [{ code: FailureCode.F6, evidence: [r.error ?? "environment error"] }];
  const path = r.transcript_ref;
  const onDisk = path !== null && existsSync(path);
  const found: Classified[] = [];
  if (path !== null && onDisk) {
    const t = readTranscript(path);
    const grade: GradeResult | null =
      r.verdict === "no_changes" || r.verdict === "agent_error"
        ? null
        : { hiddenPass: r.hidden_pass !== false, suitePass: r.suite_pass !== false, scopeOk: r.scope_ok !== false, violations: [], perTest: [] };
    // A result-only transcript carries no tool calls, so it is no evidence for F2.
    found.push(...classify({ verdict: r.verdict }, grade, t).filter((c) => t.turns > 0 || c.code !== FailureCode.F2));
  }
  for (const code of r.failure_codes) {
    if (found.some((c) => c.code === code)) continue;
    const why = r.error ? ` (${r.error})` : "";
    found.push({ code, evidence: [onDisk ? `recorded by the replay run${why}` : `transcript not on disk; recorded by the replay run${why}`] });
  }
  return found.sort((a, b) => FAILURE_ORDER.indexOf(a.code) - FAILURE_ORDER.indexOf(b.code));
}

/** Writes reports/<slug>/promotion.json: the latest promotion decision for this repo. */
function writePromotion(reportsDir: string, repo: string, doc: Record<string, unknown>): void {
  const dir = join(reportsDir, reviewSlug(repo));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "promotion.json"), JSON.stringify(doc, null, 2) + "\n");
}

/** The tool backend over the modules that exist today. The coordinator's ToolBackend contract is in ./tools.ts. */
export function defaultBackend(opts: DefaultBackendOptions = {}): ToolBackend {
  const cacheDir = resolve(opts.cacheDir ?? ".roster/cache");
  const reportsDir = resolve(opts.reportsDir ?? "reports");
  const store = new ReplayStore(opts.dbPath === undefined ? undefined : resolve(opts.dbPath));
  const replay = opts.replay ?? {};
  const runner = replayRunner({ cacheDir, ...replay });
  const readJson = <T>(repo: string, file: string): T | null => {
    const p = join(reportsDir, reviewSlug(repo), file);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
  };

  const setupsNow = () => loadSetups(replay.setupsRoot ?? process.cwd(), replay.env ?? process.env);
  const reviewNow = () => (replay.repo ? readJson<Review>(replay.repo, "review.json") : null);
  /** Replay rows are stored under the definition id; any id form the coordinator uses maps to it. */
  const defId = (id: string) => resolveSetup(id, setupsNow(), reviewNow()).id;

  const listTasks = async (repo: string, setup?: string): Promise<TaskSummary[]> => {
    const view = await loadRepo(repo, cacheDir, readJson<Outcome[]>(repo, "outcomes.json") ?? []);
    const turns = turnCounter(view.repoPath);
    const checkpointOf = new Map(view.sessions.map((s) => [s.id, s.checkpoint_id]));
    return view.tasks
      .filter((t) => setup === undefined || t.setupId === setup)
      .map((t) => {
        const checkpoint = checkpointOf.get(t.id);
        return {
          id: t.id,
          setup: t.setupId,
          track: t.track,
          tercile: t.tercile,
          userPrompts: t.userPrompts,
          originalTurns: checkpoint ? turns(checkpoint, t.id) : null,
        };
      });
  };

  return {
    async ingestRepo({ repo }) {
      const f = await fetchCheckpoints(repo, { cacheDir });
      if (f.backend === "none") throw new ToolError("no Entire checkpoints found in this repo");
      const sessions = parseCheckpoints(f.repoPath, f.backend === "refs" ? "git-refs" : "branch");
      const counts: Record<string, number> = {};
      for (const s of sessions) {
        const id = identify(s, f.repoPath).setupId ?? "unknown";
        counts[id] = (counts[id] ?? 0) + 1;
      }
      return { backend: f.backend, head: f.headSha, sessions: sessions.length, sessions_per_setup: counts };
    },

    async getScorecard({ repo }) {
      const review = readJson<Review>(repo, "review.json");
      if (!review) throw new ToolError(`no review for ${repo}; run \`roster review ${repo} --observational\` first`);
      const sessions = readJson<Session[]>(repo, "sessions.json") ?? [];
      const outcomes = readJson<Outcome[]>(repo, "outcomes.json") ?? [];
      const candidates = setupsNow()
        .filter((s) => s.candidate)
        .map(({ id, label, harness, model }) => ({ id, label, harness, model }));
      return { review, setups: summarizeSetups(sessions, outcomes), candidates };
    },

    listTasks: ({ repo, setup }) => listTasks(repo, setup),

    async sampleTasks({ repo, max, exclude }) {
      try {
        const suspect = readJson<Review>(repo, "review.json")?.suspect ?? undefined;
        const tasks = await listTasks(repo, suspect);
        return simpleSample(tasks, max, exclude, reviewSlug(repo));
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        throw new NotAvailableError(`stratified sampling for ${repo} (${why}); name the task ids explicitly`);
      }
    },

    async runReplays(a) {
      const batch = await runner({ ...a, setups: [...new Set(a.setups.map(defId))] });
      store.put(batch.replays);
      return batch;
    },

    async getReplayResults({ plan_id, setup }) {
      return store.list(plan_id, setup === undefined ? undefined : defId(setup));
    },

    async rerun({ plan_id, task, setup: asked, max_cost_usd }) {
      const known = resolveSetup(asked, setupsNow(), reviewNow());
      const setup = known.id;
      const attempt = Math.max(0, ...store.list(plan_id, setup).filter((r) => r.task_session_id === task).map((r) => r.attempt)) + 1;
      if (attempt > MAX_ATTEMPTS) throw new ToolError(`${task} under ${setup} has ${MAX_ATTEMPTS} attempts already (k = ${MAX_ATTEMPTS})`);
      if (!replay.repo) throw new Error("no repo configured for replays");
      const view = await loadRepo(replay.repo, cacheDir, []);
      const planned = view.tasks.find((t) => t.id === task);
      if (!planned) throw new ToolError(`no replayable task for session ${task}`);

      const skipped: SkippedRun[] = [];
      const replays = await runReplays({
        repo: view.repoPath,
        tasks: [planned],
        setups: [known],
        workRoot: resolve(replay.workRoot ?? defaultWorkRoot()),
        parallel: replay.parallel,
        maxCostUsd: max_cost_usd,
        harness: replay.harness,
        testCmd: replay.testCmd,
        planId: plan_id,
        attempt,
        onSkip: (s) => skipped.push(s),
      });
      if (replays.length === 0 && skipped.length > 0) throw new ToolError(`not run: ${skipped.map((s) => s.reason).join("; ")}`);
      store.put(replays);
      return { replays, cost_usd: replays.reduce((s, r) => s + (r.cost_usd ?? 0), 0), skipped } as ReplayBatch;
    },

    async classifyFailures({ plan_id, setup }) {
      const rows = store.list(plan_id, defId(setup));
      const failed = rows.filter((r) => r.verdict !== "pass");
      const replays = failed.map((r) => ({
        id: r.id,
        task: r.task_session_id,
        attempt: r.attempt,
        verdict: r.verdict,
        failures: failuresOf(r),
      }));
      const by_code: Record<string, number> = {};
      for (const r of replays) for (const f of r.failures) by_code[f.code] = (by_code[f.code] ?? 0) + 1;
      return { setup, runs: rows.length, failed: failed.length, by_code, replays };
    },

    async gate({ plan_id, candidate, incumbent, budget_usd }) {
      if (incumbent === null) throw new ToolError("the plan names no incumbent (suspect), so there is nothing to gate against");
      const inc = store.list(plan_id, defId(incumbent));
      const cand = store.list(plan_id, defId(candidate));
      // Only tasks both sides ran can split; a candidate that never ran a task is left to the gate's own reasons.
      const candTasks = new Set(cand.map((r) => r.task_session_id));
      const both = new Set(inc.map((r) => r.task_session_id).filter((t) => candTasks.has(t)));
      const open = discordant(inc, cand).filter((d) => both.has(d.task_session_id));
      if (open.length > 0) {
        const todo = open.map((d) => `${d.task_session_id} under ${d.rerun.map((s) => (s === "incumbent" ? incumbent : candidate)).join(" and ")}`);
        throw new ToolError(`the sides still split; rerun first: ${todo.join("; ")}`);
      }
      const res = decideGate(inc, cand, { budget: budget_usd });
      return {
        id: `${plan_id}:${candidate}`,
        plan_id,
        candidate,
        verdict: res.verdict,
        reasons: res.reasons,
        failed_tasks: [...new Set([...res.regressions, ...res.scope_violations])],
        trace_url: null,
      };
    },

    async promote({ repo, candidate, decision, from }) {
      if (decision.candidate !== candidate || decision.verdict !== "promote") {
        throw new ToolError(`the gate did not approve ${candidate}`);
      }
      const doc = { promoted: candidate, from, reasons: decision.reasons, at: new Date().toISOString() };
      writePromotion(reportsDir, repo, doc);
      return doc;
    },

    async revert({ repo, setup, reason }) {
      const doc = { promoted: null, from: setup, reasons: [reason], at: new Date().toISOString() };
      writePromotion(reportsDir, repo, doc);
      return doc;
    },
  };
}
