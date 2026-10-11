// Forward harness (DESIGN.md §"Forward run", §"Stop rule"): each pre-registered backlog task runs through the old and
// the new setup in paired worktrees from one commit, both results are graded, the winner is merged, and the pair is recorded.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { detectTestCmd, grade, isTestFile } from "../grade/index.ts";
import type { HiddenTest, StepRunner } from "../grade/index.ts";
import type { LlmClient } from "../llm/types.ts";
import { createSandbox, destroySandbox, runGit } from "../sandbox/index.ts";
import type { ForwardPair } from "../types.ts";
import { assignLabels, blindJudge, pairSeed, rng, secondaryOutcome } from "./blind.ts";
import type { MergeReason, Side } from "./blind.ts";
import { priceRunLog, runLogPath } from "./cost.ts";

export * from "./blind.ts";

export const DEFAULT_FORWARD_DB = ".roster/roster.db";
/**
 * Every grading step's time limit. The full suite takes about 15 minutes on the loaded build machine; grade()'s
 * 5-minute default timed every forward suite run out, so no side could pass H1 (amendment 12).
 */
export const FORWARD_STEP_TIMEOUT_MS = Number(process.env.ROSTER_GRADE_TIMEOUT_MS ?? 45 * 60_000);
/** Per-test timeout for bun in forward grading: bun's 5 s default fails tests on timing alone under load. */
export const FORWARD_BUN_TEST_TIMEOUT_MS = 60_000;

/** The test command forward grading uses for a tree: bun gets a per-test timeout; undefined leaves detection to grade(). */
export function forwardTestCmd(dir: string): string | undefined {
  try {
    const cmd = detectTestCmd(dir);
    return cmd === "bun test" ? `bun test --timeout ${FORWARD_BUN_TEST_TIMEOUT_MS}` : cmd;
  } catch {
    return undefined;
  }
}
export const MIN_PAIRS = 15;
export const MIN_NET_LOSSES = 3;

export interface BacklogTask {
  id: string;
  /** The task text, without the setup tag line. */
  body: string;
  /** Paths from the task's OWNS line; the scope guard allows edits only there. Empty when the task names none. */
  owns: string[];
}

/** Task blocks sit between "<!-- Txx -->" and "<!-- /Txx -->", the format scripts/run-setup.sh reads. */
export function parseBacklog(text: string): BacklogTask[] {
  const tasks: BacklogTask[] = [];
  const re = /^<!-- (\S+) -->\n([\s\S]*?)^<!-- \/\1 -->/gm;
  for (const m of text.matchAll(re)) {
    const lines = m[2]!.replace(/\n+$/, "").split("\n");
    if (lines[0]?.startsWith("[roster ")) lines.shift();
    const body = lines.join("\n");
    const owns = /^OWNS:\s*(.+)$/m.exec(body)?.[1]?.split(/[,\s]+/).map((s) => s.replace(/[`.;]+$/g, "").replace(/^`/, "")).filter((s) => s.includes("/") || s.includes(".")) ?? [];
    tasks.push({ id: m[1]!, body, owns });
  }
  return tasks;
}

export const setupTag = (setup: string, task: string) => `[roster setup=${setup} task=${task}]`;

/** A backlog containing only `task`, tagged for `setup`, in the format scripts/run-setup.sh expects. */
export function taggedBlock(task: BacklogTask, setup: string): string {
  return `<!-- ${task.id} -->\n${setupTag(setup, task.id)}\n${task.body}\n<!-- /${task.id} -->\n`;
}

// ---- state ----

const EXTRA_COLUMNS = {
  suite_old: "INTEGER", suite_new: "INTEGER", scope_old: "INTEGER", scope_new: "INTEGER", merged_reason: "TEXT", secondary: "TEXT",
  agent_old_ms: "INTEGER", agent_new_ms: "INTEGER", grade_ms: "INTEGER",
};

const extraValues = (p: ForwardPair) => {
  const int = (b: boolean | null | undefined) => (b === null || b === undefined ? null : +b);
  return [
    int(p.suite_pass_old), int(p.suite_pass_new), int(p.scope_ok_old), int(p.scope_ok_new), p.merged_reason ?? null, p.secondary ?? null,
    p.agent_old_ms ?? null, p.agent_new_ms ?? null, p.grade_ms ?? null,
  ] as const;
};

export class ForwardStore {
  readonly db: Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec(`CREATE TABLE IF NOT EXISTS forward_pairs (
      task_id TEXT PRIMARY KEY, setup_old TEXT NOT NULL, setup_new TEXT NOT NULL, pass_old INTEGER NOT NULL, pass_new INTEGER NOT NULL,
      cost_old REAL, cost_new REAL, merged TEXT, blind_labels TEXT NOT NULL, seed INTEGER NOT NULL, seq INTEGER NOT NULL)`);
    this.db.exec("CREATE TABLE IF NOT EXISTS forward_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // Columns added by amendment 8 and the grading timings; databases from earlier runs gain them as NULL.
    const have = new Set((this.db.query("PRAGMA table_info(forward_pairs)").all() as { name: string }[]).map((c) => c.name));
    for (const [col, type] of Object.entries(EXTRA_COLUMNS)) if (!have.has(col)) this.db.exec(`ALTER TABLE forward_pairs ADD COLUMN ${col} ${type}`);
  }

  pairs(): ForwardPair[] {
    const rows = this.db.query("SELECT * FROM forward_pairs ORDER BY seq").all() as Record<string, unknown>[];
    const bool = (v: unknown) => (v === null || v === undefined ? null : v === 1);
    return rows.map((r) => ({
      task_id: r.task_id as string,
      setup_old: r.setup_old as string,
      setup_new: r.setup_new as string,
      pass_old: r.pass_old === 1,
      pass_new: r.pass_new === 1,
      cost_old: r.cost_old as number | null,
      cost_new: r.cost_new as number | null,
      merged: r.merged as "old" | "new" | null,
      blind_labels: JSON.parse(r.blind_labels as string),
      seed: r.seed as number,
      suite_pass_old: bool(r.suite_old),
      suite_pass_new: bool(r.suite_new),
      scope_ok_old: bool(r.scope_old),
      scope_ok_new: bool(r.scope_new),
      merged_reason: (r.merged_reason ?? null) as ForwardPair["merged_reason"],
      secondary: (r.secondary ?? null) as ForwardPair["secondary"],
      agent_old_ms: (r.agent_old_ms ?? null) as number | null,
      agent_new_ms: (r.agent_new_ms ?? null) as number | null,
      grade_ms: (r.grade_ms ?? null) as number | null,
    }));
  }

  addPair(p: ForwardPair): void {
    const seq = (this.db.query("SELECT COUNT(*) AS n FROM forward_pairs").get() as { n: number }).n;
    this.db
      .query(
        `INSERT OR REPLACE INTO forward_pairs (task_id, setup_old, setup_new, pass_old, pass_new, cost_old, cost_new, merged, blind_labels, seed, seq,
          suite_old, suite_new, scope_old, scope_new, merged_reason, secondary, agent_old_ms, agent_new_ms, grade_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(p.task_id, p.setup_old, p.setup_new, +p.pass_old, +p.pass_new, p.cost_old, p.cost_new, p.merged, JSON.stringify(p.blind_labels), p.seed, seq, ...extraValues(p));
  }

  /** Rewrites a recorded pair's merge outcome (remerge). Costs and seq are left as recorded; H1 only with `withPass` (regrade). */
  updateMerge(p: ForwardPair, withPass = false): void {
    this.db
      .query("UPDATE forward_pairs SET suite_old=?, suite_new=?, scope_old=?, scope_new=?, merged_reason=?, secondary=?, agent_old_ms=?, agent_new_ms=?, grade_ms=?, merged=?, blind_labels=? WHERE task_id=?")
      .run(...extraValues(p), p.merged, JSON.stringify(p.blind_labels), p.task_id);
    if (withPass) this.db.query("UPDATE forward_pairs SET pass_old=?, pass_new=? WHERE task_id=?").run(+p.pass_old, +p.pass_new, p.task_id);
  }

  getState(key: string): string | null {
    return (this.db.query("SELECT value FROM forward_state WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;
  }
  setState(key: string, value: string): void {
    this.db.query("INSERT OR REPLACE INTO forward_state VALUES (?, ?)").run(key, value);
  }
  close(): void {
    this.db.close();
  }
}

// ---- stop rule ----

export interface StopRuleState {
  pairs: number;
  /** Discordant pairs NEW won (NEW passed, OLD failed) and lost. */
  won: number;
  lost: number;
  triggered: boolean;
}

export function evaluateStopRule(pairs: ForwardPair[]): StopRuleState {
  const won = pairs.filter((p) => p.pass_new && !p.pass_old).length;
  const lost = pairs.filter((p) => !p.pass_new && p.pass_old).length;
  return { pairs: pairs.length, won, lost, triggered: pairs.length >= MIN_PAIRS && lost - won >= MIN_NET_LOSSES };
}

export interface RevertRequest {
  setupOld: string;
  setupNew: string;
  state: StopRuleState;
}
export interface RevertOutcome {
  url: string | null;
  stub: boolean;
}

/** Opens the revert PR through src/act when it exists; until then it is a logged stub. */
export async function defaultOpenRevertPr(req: RevertRequest): Promise<RevertOutcome> {
  const spec = "../act/index.ts";
  if (existsSync(join(import.meta.dir, spec))) {
    const mod = (await import(spec)) as { openRevertPr?: (r: RevertRequest) => Promise<{ url?: string | null }> };
    if (mod.openRevertPr) return { url: (await mod.openRevertPr(req)).url ?? null, stub: false };
  }
  return { url: null, stub: true };
}

// ---- harness ----

export interface HarnessRequest {
  task: BacklogTask;
  setup: string;
  side: Side;
  /** A worktree on its own branch at the pair's base commit, already created. */
  worktree: string;
  branch: string;
  /** A task file holding this task's block tagged for this setup (ROSTER_TASKS). */
  tasksFile: string;
}
export interface HarnessResult {
  costUsd: number | null;
}
export type Harness = (req: HarnessRequest) => Promise<HarnessResult>;

/** Launches scripts/run-setup.sh, which pre-existing worktrees skip creating, so both sides share one base commit. */
export function runSetupHarness(repo: string): Harness {
  return async (req) => {
    const env = {
      ...process.env,
      ROSTER_TASKS: req.tasksFile,
      ROSTER_WT: dirname(req.worktree),
    };
    const proc = Bun.spawn(["bash", join(repo, "scripts", "run-setup.sh"), req.setup, req.task.id], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    // Priced from the run's tokens, not Claude Code's total_cost_usd (which prices DeepSeek at Claude rates).
    const { usd } = priceRunLog(runLogPath(join(repo, ".roster", "runs"), req.task.id, req.setup), new Date());
    return { costUsd: usd };
  };
}

// ---- helpers ----

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const r = this.tail.then(fn);
    this.tail = r.then(
      () => undefined,
      () => undefined,
    );
    return r;
  }
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Acceptance tests for a task: every file under <acceptanceDir>/<id>/, mirrored at the same relative path in the repo. */
export function loadAcceptance(acceptanceDir: string, id: string): HiddenTest[] {
  const dir = join(acceptanceDir, id);
  if (!existsSync(dir)) return [];
  return walk(dir).map((f) => ({ path: relative(dir, f), content: readFileSync(f, "utf8") }));
}

export interface SideGrade {
  pass: boolean;
  hiddenPass: boolean;
  /** null = the full suite was not run for this side. */
  suitePass: boolean | null;
  scopeOk: boolean;
  /** The change's own new tests and the typecheck did not fail (acceptance not considered). */
  checksOk: boolean;
}

/**
 * phase "fast": acceptance + the change's own new tests + typecheck, no full suite (suitePass null).
 * phase "suite": the full suite only; `pass` is then the suite result.
 */
async function gradeBranch(opts: {
  repo: string;
  base: string;
  head: string;
  hidden: HiddenTest[];
  owns: string[];
  testCmd?: string;
  scratch: string;
  phase: "fast" | "suite";
  runner?: StepRunner;
}): Promise<SideGrade> {
  const sandbox = await createSandbox(opts.repo, opts.base, { root: opts.scratch });
  try {
    const patch = runGit(opts.repo, ["diff", "--binary", opts.base, opts.head]);
    if (patch) {
      const pf = join(sandbox.path, "..", `${sandbox.path.split("/").at(-1)}.patch`);
      writeFileSync(pf, patch + "\n");
      runGit(sandbox.path, ["apply", "--binary", pf]);
      rmSync(pf, { force: true });
    }
    const preexistingTests = runGit(opts.repo, ["ls-tree", "-r", "--name-only", opts.base]).split("\n").filter((p) => p && isTestFile(p));
    const r = await grade({
      sandbox,
      hidden: opts.hidden,
      preexistingTests,
      touchedDirs: opts.owns.length ? opts.owns : undefined,
      testCmd: opts.testCmd ?? forwardTestCmd(sandbox.path),
      timeoutMs: FORWARD_STEP_TIMEOUT_MS,
      phase: opts.phase,
      modulesFrom: opts.repo,
      runner: opts.runner,
    });
    const checksOk = r.typecheckPass !== false && r.ownPass !== false;
    // Fast: acceptance AND scope. Typecheck and the side's own new tests only feed `checksOk` (amendment 8 candidacy), never H1.
    const pass = opts.phase === "suite" ? r.suitePass === true : r.hiddenPass && r.scopeOk;
    return { pass, hiddenPass: r.hiddenPass, suitePass: r.suitePass, scopeOk: r.scopeOk, checksOk };
  } finally {
    await destroySandbox(sandbox.path);
  }
}

// ---- merge decision ----

interface SettleContext {
  repo: string;
  git: Mutex;
  llm: LlmClient;
  log: (line: string) => void;
  /** Amendment 8's build-only policy and the exploratory secondary outcome. */
  buildMerge: boolean;
}

interface SideState {
  branch: string;
  /** The commit the side's branch started from, and its tip. */
  base: string;
  head: string;
  /** The change's own new tests and the typecheck did not fail. */
  checksOk: boolean;
  scopeOk: boolean;
}

function mergeBranch(ctx: SettleContext, taskId: string, branch: string, setup: string): Promise<boolean> {
  return ctx.git.run(() => {
    const r = Bun.spawnSync(["git", "merge", "--no-ff", "-m", `${taskId}: merge forward winner (${setup})`, branch], { cwd: ctx.repo, env: { ...process.env, GIT_EDITOR: "true" } });
    if (r.exitCode !== 0) {
      Bun.spawnSync(["git", "merge", "--abort"], { cwd: ctx.repo });
      ctx.log(`forward: ${taskId}: merge of ${branch} failed, left unmerged: ${r.stderr.toString().trim()}`);
      return false;
    }
    return true;
  });
}

type Settled = Pick<ForwardPair, "blind_labels" | "merged" | "merged_reason" | "secondary" | "suite_pass_old" | "suite_pass_new" | "scope_ok_old" | "scope_ok_new"> & {
  /** H1 pass per side: a candidate that failed its full suite is a fail. */
  pass: Record<Side, boolean>;
};

/**
 * Runs the blind judge when the policy needs it, orders the merge candidates, runs the full suite on the first one (the next
 * if it fails), merges the first to pass, and records why. Candidates, in order: (a) sides that pass acceptance, the judge's
 * pick first when both do; (b) build only, when both fail acceptance: sides whose fast checks pass with scope ok.
 */
async function settle(
  ctx: SettleContext,
  task: BacklogTask,
  seed: number,
  setups: Record<Side, string>,
  acceptance: Record<Side, boolean>,
  sides: Record<Side, SideState>,
  runSuite: (side: Side) => Promise<boolean>,
  /** Remerge: `acceptance` is the recorded H1 result and stays as it is; no side's H1 is re-derived. */
  keepPass = false,
): Promise<Settled> {
  const random = rng(seed);
  let labels = assignLabels(random);
  const pass = { ...acceptance };
  const eligible = { old: sides.old.checksOk && sides.old.scopeOk, new: sides.new.checksOk && sides.new.scopeOk };
  // Each side's full suite runs at most once; the result is reused by H1 and by merge confirmation.
  const suite: Record<Side, boolean | null> = { old: null, new: null };
  const pending: Partial<Record<Side, Promise<boolean>>> = {};
  const ensureSuite = (s: Side) => (pending[s] ??= runSuite(s).then((ok) => (suite[s] = ok)));
  // H1 = acceptance AND scope (`acceptance` here) AND the full suite, so every side that has the first two is suite-graded.
  if (!keepPass) {
    const graded = (["old", "new"] as const).filter((s) => acceptance[s]);
    await Promise.all(graded.map(async (s) => (pass[s] = await ensureSuite(s))));
  }
  // Without amendment 8 the judge only breaks both-pass ties; with it, it also ranks two sides that clear fast checks and scope.
  const judgeOn = ctx.buildMerge ? eligible : pass;
  let preferred: Side | null = null;
  if (judgeOn.old && judgeOn.new) {
    const diffs = {
      old: runGit(ctx.repo, ["diff", sides.old.base, sides.old.head]),
      new: runGit(ctx.repo, ["diff", sides.new.base, sides.new.head]),
    };
    // A fresh stream from the same seed draws the same labels as above, so the logged seed reproduces them.
    const judged = await blindJudge(ctx.llm, task.body, diffs, rng(seed), [setups.old, setups.new]);
    labels = judged.labels;
    preferred = judged.preferred;
    ctx.log(`forward: ${task.id}: judge ${judged.verdict} (X=${labels.X}, Y=${labels.Y})`);
  }
  const other = (s: Side): Side => (s === "old" ? "new" : "old");
  /** The judge's pick when both are in play, else a seeded random one. */
  const first = () => preferred ?? (random() < 0.5 ? "old" : "new");
  const candidates: { side: Side; reason: MergeReason }[] = [];
  const group = pass.old || pass.new ? pass : ctx.buildMerge ? eligible : { old: false, new: false };
  const tail: MergeReason = group === pass ? "pass_beats_fail" : "suite_scope";
  if (group.old && group.new) {
    const f = first();
    const viaJudge = preferred !== null;
    candidates.push({ side: f, reason: group === pass ? (viaJudge ? "judge" : "random_tie") : viaJudge ? "suite_scope_judge" : "suite_scope_random_tie" }, { side: other(f), reason: tail });
  } else if (group.old || group.new) candidates.push({ side: group.old ? "old" : "new", reason: tail });

  let merged: Side | null = null;
  let reason: MergeReason = "both_failed";
  for (const c of candidates) {
    if (await ensureSuite(c.side)) {
      merged = c.side;
      reason = c.reason;
      break;
    }
    ctx.log(`forward: ${task.id}: ${c.side} failed the full suite`);
  }
  if (merged && !(await mergeBranch(ctx, task.id, sides[merged].branch, setups[merged]))) {
    merged = null;
    reason = "merge_failed";
  }
  const secondary = ctx.buildMerge ? secondaryOutcome(eligible, preferred) : null;
  ctx.log(
    `forward: ${task.id}: old ${pass.old ? "pass" : "fail"}, new ${pass.new ? "pass" : "fail"}, ${reason}, merged ${merged ?? "none"}, seed ${seed}` +
      (secondary ? `; secondary (exploratory) ${secondary}` : ""),
  );
  return {
    pass,
    blind_labels: labels,
    merged,
    merged_reason: reason,
    secondary,
    suite_pass_old: suite.old,
    suite_pass_new: suite.new,
    scope_ok_old: sides.old.scopeOk,
    scope_ok_new: sides.new.scopeOk,
  };
}

// ---- the run ----

export interface ForwardOptions {
  repo: string;
  backlog: string;
  pair: { old: string; new: string };
  parallel?: number;
  harness?: Harness;
  /** The blind diff-judge's model client. */
  llm: LlmClient;
  db?: string;
  wtRoot?: string;
  acceptanceDir?: string;
  /** Overrides test-command detection for the full suite and the acceptance tests. */
  testCmd?: string;
  /** Run seed; each pair's seed is derived from it and the task id. Default: random, and logged. */
  seed?: number;
  /** Replaces the shell runner for grading steps (tests count and stub the suite runs through it). */
  gradeRunner?: StepRunner;
  openRevertPr?: (req: RevertRequest) => Promise<RevertOutcome>;
  log?: (line: string) => void;
  /**
   * Pre-registration amendment 8, build only: when both sides fail acceptance, merge the side whose suite passes with
   * scope ok (the blind judge picks between two), and record the exploratory secondary outcome. pass_old/pass_new (H1)
   * are unaffected. Off by default so the registered policy stays the library's; `roster forward` turns it on.
   */
  buildMerge?: boolean;
  /** Whether a side's agent finished in an earlier run (resume). Default: its run log holds a result event. */
  agentDone?: (taskId: string, setup: string) => boolean;
}

/** Most tasks in flight at once. */
export const MAX_PARALLEL = 4;

export interface ForwardSummary {
  completed: ForwardPair[];
  skipped: string[];
  /** Tasks run on the old setup alone after the stop rule triggered. */
  soloOnOld: string[];
  /** Tasks whose pair threw (agent launch or grading); nothing was recorded, so a rerun retries them. */
  errored: string[];
  /** Tasks whose agents had already finished in an earlier run: graded from their branches without re-running them. */
  resumed: string[];
  stop: StopRuleState;
  reverted: RevertOutcome | null;
  seed: number;
}

export async function runForward(opts: ForwardOptions): Promise<ForwardSummary> {
  const log = opts.log ?? (() => undefined);
  const repo = resolve(opts.repo);
  const wtRoot = resolve(opts.wtRoot ?? "/Users/Shared/roster-wt/forward");
  const acceptanceDir = resolve(repo, opts.acceptanceDir ?? "experiments/acceptance");
  const harness = opts.harness ?? runSetupHarness(repo);
  const store = new ForwardStore(resolve(opts.db ?? DEFAULT_FORWARD_DB));
  const tasks = parseBacklog(opts.backlog);
  const runSeed = opts.seed ?? Number(store.getState("seed") ?? Math.floor(Math.random() * 2 ** 31));
  store.setState("seed", String(runSeed));
  log(`forward: run seed ${runSeed}`);

  const done = new Set(store.pairs().map((p) => p.task_id));
  const solo = new Set<string>(JSON.parse(store.getState("solo") ?? "[]"));
  const skipped = tasks.filter((t) => done.has(t.id) || solo.has(t.id)).map((t) => t.id);
  const queue = tasks.filter((t) => !done.has(t.id) && !solo.has(t.id));
  const git = new Mutex();
  const scratch = mkdtempSync(join(tmpdir(), "roster-forward-"));
  const completed: ForwardPair[] = [];
  const soloOnOld: string[] = [];
  const errored: string[] = [];
  const resumed: string[] = [];
  let reverted: RevertOutcome | null = store.getState("reverted") ? JSON.parse(store.getState("reverted")!) : null;
  let revertedFlag = reverted !== null;

  const startSide = async (task: BacklogTask, side: Side, setup: string, base: string) => {
    const worktree = join(wtRoot, side, task.id);
    const branch = `forward/${task.id}/${side}`;
    await git.run(() => {
      if (!existsSync(worktree)) {
        mkdirSync(dirname(worktree), { recursive: true });
        const exists = Bun.spawnSync(["git", "rev-parse", "--verify", "-q", branch], { cwd: repo }).exitCode === 0;
        runGit(repo, exists ? ["worktree", "add", "-q", worktree, branch] : ["worktree", "add", "-q", worktree, "-b", branch, base]);
      }
    });
    const tasksFile = join(scratch, `${task.id}.${side}.md`);
    writeFileSync(tasksFile, taggedBlock(task, setup));
    const res = await harness({ task, setup, side, worktree, branch, tasksFile });
    // Whatever the agent left uncommitted is part of its change.
    const head = await git.run(() => {
      runGit(worktree, ["add", "-A"]);
      if (runGit(worktree, ["status", "--porcelain"])) runGit(worktree, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", `${task.id}: uncommitted work from ${side} run`]);
      return runGit(worktree, ["rev-parse", "HEAD"]);
    });
    return { branch, head, costUsd: res.costUsd };
  };

  const ctx: SettleContext = { repo, git, llm: opts.llm, log, buildMerge: opts.buildMerge ?? false };

  const timed = async <T>(f: () => Promise<T>) => {
    const t0 = Date.now();
    const v = await f();
    return { v, ms: Date.now() - t0 };
  };
  const gradeFast = (task: BacklogTask, base: string, head: string, hidden: HiddenTest[]) =>
    gradeBranch({ repo, base, head, hidden, owns: task.owns, testCmd: opts.testCmd, scratch, phase: "fast", runner: opts.gradeRunner });
  const gradeSuite = async (task: BacklogTask, base: string, head: string) =>
    (await gradeBranch({ repo, base, head, hidden: [], owns: task.owns, testCmd: opts.testCmd, scratch, phase: "suite", runner: opts.gradeRunner })).pass;

  const runsDir = join(repo, ".roster", "runs");
  const agentDone =
    opts.agentDone ??
    ((id: string, setup: string) => {
      try {
        return readFileSync(runLogPath(runsDir, id, setup), "utf8").includes('"type":"result"');
      } catch {
        return false;
      }
    });
  const branchExists = (b: string) => Bun.spawnSync(["git", "rev-parse", "--verify", "-q", b], { cwd: repo }).exitCode === 0;
  /**
   * Sides an earlier run left behind (amendment 12). Both agents finished: grade their branches from the pair's base
   * (where the two branches meet) without re-running them. Anything partial is discarded, so the pair starts clean.
   */
  const prior = (task: BacklogTask) =>
    git.run(() => {
      const sides = {
        old: { worktree: join(wtRoot, "old", task.id), branch: `forward/${task.id}/old` },
        new: { worktree: join(wtRoot, "new", task.id), branch: `forward/${task.id}/new` },
      };
      const present = (s: Side) => existsSync(sides[s].worktree) && branchExists(sides[s].branch);
      if (present("old") && present("new") && agentDone(task.id, opts.pair.old) && agentDone(task.id, opts.pair.new)) {
        const heads = { old: "", new: "" };
        for (const s of ["old", "new"] as const) {
          const wt = sides[s].worktree;
          runGit(wt, ["add", "-A"]);
          if (runGit(wt, ["status", "--porcelain"])) runGit(wt, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", `${task.id}: uncommitted work from ${s} run`]);
          heads[s] = runGit(wt, ["rev-parse", "HEAD"]);
        }
        return { base: runGit(repo, ["merge-base", sides.old.branch, sides.new.branch]), heads, sides };
      }
      for (const s of ["old", "new"] as const) {
        if (existsSync(sides[s].worktree)) {
          if (Bun.spawnSync(["git", "worktree", "remove", "--force", sides[s].worktree], { cwd: repo }).exitCode !== 0) {
            rmSync(sides[s].worktree, { recursive: true, force: true });
            Bun.spawnSync(["git", "worktree", "prune"], { cwd: repo });
          }
        }
        if (branchExists(sides[s].branch)) runGit(repo, ["branch", "-D", sides[s].branch]);
      }
      return null;
    });

  const runPair = async (task: BacklogTask): Promise<ForwardPair> => {
    const resume = await prior(task);
    const base = resume?.base ?? (await git.run(() => runGit(repo, ["rev-parse", "HEAD"])));
    const seed = pairSeed(runSeed, task.id);
    let o: { branch: string; head: string; costUsd: number | null };
    let n: { branch: string; head: string; costUsd: number | null };
    let agentOldMs: number | null = null;
    let agentNewMs: number | null = null;
    if (resume) {
      resumed.push(task.id);
      log(`forward: ${task.id}: both agents finished in an earlier run; grading their branches from base ${base.slice(0, 7)}`);
      const cost = (setup: string) => priceRunLog(runLogPath(runsDir, task.id, setup), new Date()).usd;
      o = { branch: resume.sides.old.branch, head: resume.heads.old, costUsd: cost(opts.pair.old) };
      n = { branch: resume.sides.new.branch, head: resume.heads.new, costUsd: cost(opts.pair.new) };
    } else {
      const [ro, rn] = await Promise.all([timed(() => startSide(task, "old", opts.pair.old, base)), timed(() => startSide(task, "new", opts.pair.new, base))]);
      ({ v: o, ms: agentOldMs } = ro);
      ({ v: n, ms: agentNewMs } = rn);
    }
    const hidden = loadAcceptance(acceptanceDir, task.id);
    // Fast checks and the scope guard for both sides at once; the full suite then runs on merge candidates only.
    const { v: fast, ms: fastMs } = await timed(() => Promise.all([gradeFast(task, base, o.head, hidden), gradeFast(task, base, n.head, hidden)]));
    let gradeMs = fastMs;
    let active = 0;
    let busySince = 0;
    const heads = { old: o.head, new: n.head };
    const settled = await settle(
      ctx, task, seed, opts.pair, { old: fast[0].pass, new: fast[1].pass },
      {
        old: { branch: o.branch, base, head: o.head, checksOk: fast[0].checksOk, scopeOk: fast[0].scopeOk },
        new: { branch: n.branch, base, head: n.head, checksOk: fast[1].checksOk, scopeOk: fast[1].scopeOk },
      },
      async (side) => {
        // Suites of the two sides may overlap: grade_ms counts wall time with at least one step running.
        if (active++ === 0) busySince = Date.now();
        try {
          return await gradeSuite(task, base, heads[side]);
        } finally {
          if (--active === 0) gradeMs += Date.now() - busySince;
        }
      },
    );
    const { pass, ...rest } = settled;
    return {
      task_id: task.id,
      setup_old: opts.pair.old,
      setup_new: opts.pair.new,
      pass_old: pass.old,
      pass_new: pass.new,
      cost_old: o.costUsd,
      cost_new: n.costUsd,
      seed,
      ...rest,
      agent_old_ms: agentOldMs,
      agent_new_ms: agentNewMs,
      grade_ms: gradeMs,
    };
  };

  const runSolo = async (task: BacklogTask) => {
    const base = await git.run(() => runGit(repo, ["rev-parse", "HEAD"]));
    const o = await startSide(task, "old", opts.pair.old, base);
    const fast = await gradeFast(task, base, o.head, loadAcceptance(acceptanceDir, task.id));
    const passed = fast.pass && (await gradeSuite(task, base, o.head));
    if (passed) await mergeBranch(ctx, task.id, o.branch, opts.pair.old);
    solo.add(task.id);
    soloOnOld.push(task.id);
    store.setState("solo", JSON.stringify([...solo]));
    log(`forward: ${task.id}: run on old setup only (stop rule): ${passed ? "pass, merged" : "fail"}`);
  };

  const onPair = async (pair: ForwardPair) => {
    store.addPair(pair);
    completed.push(pair);
    const state = evaluateStopRule(store.pairs());
    if (state.triggered && !revertedFlag) {
      revertedFlag = true;
      log(`forward: stop rule: new lost ${state.lost}, won ${state.won} discordant pairs over ${state.pairs}; opening revert PR`);
      reverted = await (opts.openRevertPr ?? defaultOpenRevertPr)({ setupOld: opts.pair.old, setupNew: opts.pair.new, state });
      store.setState("reverted", JSON.stringify(reverted));
      log(reverted.stub ? "forward: revert PR is a stub (src/act is absent); continuing on the old setup" : `forward: revert PR ${reverted.url}; continuing on the old setup`);
    }
  };

  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      try {
        if (revertedFlag) await runSolo(t);
        else await onPair(await runPair(t));
      } catch (e) {
        // One pair's failure (agent launch, grading copy, git) must not end the run; nothing is recorded, so a rerun retries it.
        errored.push(t.id);
        log(`forward: ${t.id}: error, pair not recorded: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: clampParallel(opts.parallel) }, worker));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const stop = evaluateStopRule(store.pairs());
  store.close();
  return { completed, skipped, soloOnOld, errored, resumed, stop, reverted, seed: runSeed };
}

function clampParallel(n: number | undefined): number {
  return Math.min(MAX_PARALLEL, Math.max(1, n ?? MAX_PARALLEL));
}

// ---- remerge ----

export interface RemergeOptions {
  repo: string;
  /** The backlog the pairs came from: task text for the judge and OWNS for the scope guard. */
  backlog: string;
  llm: LlmClient;
  db?: string;
  testCmd?: string;
  parallel?: number;
  log?: (line: string) => void;
  /**
   * Regrade (amendment 12): also re-run the acceptance tests and recompute H1 (pass_old/pass_new) with the current
   * grader, for pairs graded while every suite run timed out. Without it, the recorded H1 stays as it is.
   */
  regrade?: boolean;
  /** Only these task ids (default: every unmerged pair). */
  tasks?: string[];
  acceptanceDir?: string;
  gradeRunner?: StepRunner;
}

export interface RemergeSummary {
  revisited: ForwardPair[];
  /** Unmerged pairs that could not be revisited: task missing from the backlog, or a side branch gone. */
  skipped: string[];
}

/**
 * `roster forward --remerge`: for every recorded pair with nothing merged, re-grades the full suite and the scope guard on
 * both side branches and applies the amendment 8 merge policy. Acceptance results (H1) are kept as recorded, never re-run.
 */
export async function remergeForward(opts: RemergeOptions): Promise<RemergeSummary> {
  const log = opts.log ?? (() => undefined);
  const repo = resolve(opts.repo);
  const store = new ForwardStore(resolve(opts.db ?? DEFAULT_FORWARD_DB));
  const tasks = new Map(parseBacklog(opts.backlog).map((t) => [t.id, t]));
  const only = opts.tasks ? new Set(opts.tasks) : null;
  const queue = store.pairs().filter((p) => p.merged === null && (!only || only.has(p.task_id)));
  const acceptanceDir = resolve(repo, opts.acceptanceDir ?? "experiments/acceptance");
  const git = new Mutex();
  const ctx: SettleContext = { repo, git, llm: opts.llm, log, buildMerge: true };
  const scratch = mkdtempSync(join(tmpdir(), "roster-remerge-"));
  const revisited: ForwardPair[] = [];
  const skipped: string[] = [];

  const revisit = async (p: ForwardPair) => {
    const task = tasks.get(p.task_id);
    if (!task) {
      log(`forward: remerge ${p.task_id}: not in the backlog, skipped`);
      return skipped.push(p.task_id);
    }
    const refs = await git.run(() => {
      const out: Partial<Record<Side, { branch: string; head: string; base: string }>> = {};
      for (const side of ["old", "new"] as const) {
        const branch = `forward/${p.task_id}/${side}`;
        const r = Bun.spawnSync(["git", "rev-parse", "--verify", "-q", branch], { cwd: repo });
        if (r.exitCode !== 0) continue;
        // The side branch was cut from the pair's base commit, which is where it meets the current HEAD.
        out[side] = { branch, head: r.stdout.toString().trim(), base: runGit(repo, ["merge-base", "HEAD", branch]) };
      }
      return out;
    });
    if (!refs.old || !refs.new) {
      log(`forward: remerge ${p.task_id}: side branch missing, skipped`);
      return skipped.push(p.task_id);
    }
    const hidden = opts.regrade ? loadAcceptance(acceptanceDir, task.id) : [];
    const grade = (r: { head: string; base: string }, phase: "fast" | "suite") =>
      gradeBranch({ repo, base: r.base, head: r.head, hidden: phase === "fast" ? hidden : [], owns: task.owns, testCmd: opts.testCmd, scratch, phase, runner: opts.gradeRunner });
    // Remerge keeps the recorded acceptance results; regrade re-runs them. Either way the fast checks (new tests,
    // typecheck) and scope are re-graded, then the suite: on candidates, and with regrade on every acceptance pass (H1).
    const sideOf = async (r: { branch: string; head: string; base: string }) => {
      const g = await grade(r, "fast");
      return { state: { ...r, checksOk: g.checksOk, scopeOk: g.scopeOk } as SideState, acceptance: g.pass };
    };
    const [o, n] = await Promise.all([sideOf(refs.old), sideOf(refs.new)]);
    const acceptance = opts.regrade ? { old: o.acceptance, new: n.acceptance } : { old: p.pass_old, new: p.pass_new };
    const settled = await settle(
      ctx, task, p.seed, { old: p.setup_old, new: p.setup_new }, acceptance, { old: o.state, new: n.state },
      async (side) => (await grade(side === "old" ? o.state : n.state, "suite")).pass,
      !opts.regrade,
    );
    const { pass, ...rest } = settled;
    const updated: ForwardPair = opts.regrade ? { ...p, ...rest, pass_old: pass.old, pass_new: pass.new } : { ...p, ...rest };
    store.updateMerge(updated, opts.regrade ?? false);
    if (opts.regrade && (updated.pass_old !== p.pass_old || updated.pass_new !== p.pass_new)) {
      log(`forward: regrade ${p.task_id}: H1 old ${p.pass_old ? "pass" : "fail"} -> ${updated.pass_old ? "pass" : "fail"}, new ${p.pass_new ? "pass" : "fail"} -> ${updated.pass_new ? "pass" : "fail"}`);
    }
    revisited.push(updated);
  };

  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      try {
        await revisit(p);
      } catch (e) {
        // One pair's failure must not abort the rest; it stays unmerged and a later run retries it.
        skipped.push(p.task_id);
        log(`forward: remerge ${p.task_id}: error, left as recorded: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: clampParallel(opts.parallel) }, worker));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    store.close();
  }
  return { revisited, skipped };
}
