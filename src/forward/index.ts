// Forward harness (DESIGN.md §"Forward run", §"Stop rule"): each pre-registered backlog task runs through the old and
// the new setup in paired worktrees from one commit, both results are graded, the winner is merged, and the pair is recorded.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { grade, isTestFile } from "../grade/index.ts";
import type { HiddenTest } from "../grade/index.ts";
import type { LlmClient } from "../llm/types.ts";
import { createSandbox, destroySandbox, runGit } from "../sandbox/index.ts";
import type { ForwardPair } from "../types.ts";
import { assignLabels, blindJudge, chooseMerge, pairSeed, rng, secondaryOutcome } from "./blind.ts";
import type { MergeChoice, MergeReason, Side } from "./blind.ts";

export * from "./blind.ts";

export const DEFAULT_FORWARD_DB = ".roster/roster.db";
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

const EXTRA_COLUMNS = { suite_old: "INTEGER", suite_new: "INTEGER", scope_old: "INTEGER", scope_new: "INTEGER", merged_reason: "TEXT", secondary: "TEXT" };

const extraValues = (p: ForwardPair) => {
  const int = (b: boolean | null | undefined) => (b === null || b === undefined ? null : +b);
  return [int(p.suite_pass_old), int(p.suite_pass_new), int(p.scope_ok_old), int(p.scope_ok_new), p.merged_reason ?? null, p.secondary ?? null] as const;
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
    // Columns added by amendment 8; databases from earlier runs gain them as NULL.
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
    }));
  }

  addPair(p: ForwardPair): void {
    const seq = (this.db.query("SELECT COUNT(*) AS n FROM forward_pairs").get() as { n: number }).n;
    this.db
      .query(
        `INSERT OR REPLACE INTO forward_pairs (task_id, setup_old, setup_new, pass_old, pass_new, cost_old, cost_new, merged, blind_labels, seed, seq,
          suite_old, suite_new, scope_old, scope_new, merged_reason, secondary) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(p.task_id, p.setup_old, p.setup_new, +p.pass_old, +p.pass_new, p.cost_old, p.cost_new, p.merged, JSON.stringify(p.blind_labels), p.seed, seq, ...extraValues(p));
  }

  /** Rewrites a recorded pair's merge outcome (remerge). The H1 fields, costs and seq are left as recorded. */
  updateMerge(p: ForwardPair): void {
    this.db
      .query("UPDATE forward_pairs SET suite_old=?, suite_new=?, scope_old=?, scope_new=?, merged_reason=?, secondary=?, merged=?, blind_labels=? WHERE task_id=?")
      .run(...extraValues(p), p.merged, JSON.stringify(p.blind_labels), p.task_id);
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
    const log = join(repo, ".roster", "runs", `${req.task.id}.${req.setup}.jsonl`);
    let costUsd: number | null = null;
    try {
      const line = readFileSync(log, "utf8").split("\n").filter((l) => l.includes('"type":"result"')).at(-1);
      const c = line ? JSON.parse(line).total_cost_usd : null;
      costUsd = typeof c === "number" ? c : null;
    } catch {
      /* no log: cost stays unknown, never a guess */
    }
    return { costUsd };
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
  suitePass: boolean;
  scopeOk: boolean;
}

async function gradeBranch(opts: {
  repo: string;
  base: string;
  head: string;
  hidden: HiddenTest[];
  owns: string[];
  testCmd?: string;
  scratch: string;
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
      testCmd: opts.testCmd,
    });
    return { pass: r.hiddenPass && r.suitePass && r.scopeOk, hiddenPass: r.hiddenPass, suitePass: r.suitePass, scopeOk: r.scopeOk };
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
  suitePass: boolean;
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

type Settled = Pick<ForwardPair, "blind_labels" | "merged" | "merged_reason" | "secondary" | "suite_pass_old" | "suite_pass_new" | "scope_ok_old" | "scope_ok_new">;

/** Runs the blind judge when the policy needs it, picks the side to merge, merges it, and records why. */
async function settle(
  ctx: SettleContext,
  task: BacklogTask,
  seed: number,
  setups: Record<Side, string>,
  pass: Record<Side, boolean>,
  sides: Record<Side, SideState>,
): Promise<Settled> {
  const random = rng(seed);
  let labels = assignLabels(random);
  const eligible = { old: sides.old.suitePass && sides.old.scopeOk, new: sides.new.suitePass && sides.new.scopeOk };
  // Without amendment 8 the judge only breaks both-pass ties; with it, it also ranks two suite+scope-ok sides.
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
  const choice: MergeChoice = chooseMerge(pass, preferred, random, ctx.buildMerge ? eligible : undefined);
  let merged = choice.merged;
  let reason: MergeReason = choice.reason;
  if (merged && !(await mergeBranch(ctx, task.id, sides[merged].branch, setups[merged]))) {
    merged = null;
    reason = "merge_failed";
  }
  const secondary = ctx.buildMerge ? secondaryOutcome(eligible, preferred) : null;
  ctx.log(
    `forward: ${task.id}: old ${pass.old ? "pass" : "fail"}, new ${pass.new ? "pass" : "fail"}, ${choice.reason}, merged ${merged ?? "none"}, seed ${seed}` +
      (secondary ? `; secondary (exploratory) ${secondary}` : ""),
  );
  return {
    blind_labels: labels,
    merged,
    merged_reason: reason,
    secondary,
    suite_pass_old: sides.old.suitePass,
    suite_pass_new: sides.new.suitePass,
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
  openRevertPr?: (req: RevertRequest) => Promise<RevertOutcome>;
  log?: (line: string) => void;
  /**
   * Pre-registration amendment 8, build only: when both sides fail acceptance, merge the side whose suite passes with
   * scope ok (the blind judge picks between two), and record the exploratory secondary outcome. pass_old/pass_new (H1)
   * are unaffected. Off by default so the registered policy stays the library's; `roster forward` turns it on.
   */
  buildMerge?: boolean;
}

/** Most tasks in flight at once. */
export const MAX_PARALLEL = 4;

export interface ForwardSummary {
  completed: ForwardPair[];
  skipped: string[];
  /** Tasks run on the old setup alone after the stop rule triggered. */
  soloOnOld: string[];
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

  const runPair = async (task: BacklogTask): Promise<ForwardPair> => {
    const base = await git.run(() => runGit(repo, ["rev-parse", "HEAD"]));
    const seed = pairSeed(runSeed, task.id);
    const [o, n] = await Promise.all([startSide(task, "old", opts.pair.old, base), startSide(task, "new", opts.pair.new, base)]);
    const hidden = loadAcceptance(acceptanceDir, task.id);
    const gradeSide = (s: { head: string }) => gradeBranch({ repo, base, head: s.head, hidden, owns: task.owns, testCmd: opts.testCmd, scratch });
    const [go, gn] = await Promise.all([gradeSide(o), gradeSide(n)]);
    const pass = { old: go.pass, new: gn.pass };
    const settled = await settle(ctx, task, seed, opts.pair, pass, {
      old: { branch: o.branch, base, head: o.head, suitePass: go.suitePass, scopeOk: go.scopeOk },
      new: { branch: n.branch, base, head: n.head, suitePass: gn.suitePass, scopeOk: gn.scopeOk },
    });
    return {
      task_id: task.id,
      setup_old: opts.pair.old,
      setup_new: opts.pair.new,
      pass_old: pass.old,
      pass_new: pass.new,
      cost_old: o.costUsd,
      cost_new: n.costUsd,
      seed,
      ...settled,
    };
  };

  const runSolo = async (task: BacklogTask) => {
    const base = await git.run(() => runGit(repo, ["rev-parse", "HEAD"]));
    const o = await startSide(task, "old", opts.pair.old, base);
    const g = await gradeBranch({ repo, base, head: o.head, hidden: loadAcceptance(acceptanceDir, task.id), owns: task.owns, testCmd: opts.testCmd, scratch });
    if (g.pass) await mergeBranch(ctx, task.id, o.branch, opts.pair.old);
    solo.add(task.id);
    soloOnOld.push(task.id);
    store.setState("solo", JSON.stringify([...solo]));
    log(`forward: ${task.id}: run on old setup only (stop rule): ${g.pass ? "pass, merged" : "fail"}`);
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
      if (revertedFlag) await runSolo(t);
      else await onPair(await runPair(t));
    }
  };
  try {
    await Promise.all(Array.from({ length: clampParallel(opts.parallel) }, worker));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const stop = evaluateStopRule(store.pairs());
  store.close();
  return { completed, skipped, soloOnOld, stop, reverted, seed: runSeed };
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
  const queue = store.pairs().filter((p) => p.merged === null);
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
    const sideOf = async (r: { branch: string; head: string; base: string }): Promise<SideState> => {
      const g = await gradeBranch({ repo, base: r.base, head: r.head, hidden: [], owns: task.owns, testCmd: opts.testCmd, scratch });
      return { ...r, suitePass: g.suitePass, scopeOk: g.scopeOk };
    };
    const [o, n] = await Promise.all([sideOf(refs.old), sideOf(refs.new)]);
    const settled = await settle(ctx, task, p.seed, { old: p.setup_old, new: p.setup_new }, { old: p.pass_old, new: p.pass_new }, { old: o, new: n });
    const updated: ForwardPair = { ...p, ...settled };
    store.updateMerge(updated);
    revisited.push(updated);
  };

  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) await revisit(p);
  };
  try {
    await Promise.all(Array.from({ length: clampParallel(opts.parallel) }, worker));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    store.close();
  }
  return { revisited, skipped };
}
