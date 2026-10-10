// Task ledger for our own build (DESIGN.md §"Self-build protocol"). Turns this repo into a labelled
// dataset: every build task's setup, prompt hash, branch, merge commit and Entire checkpoints/sessions.
//
//   bun scripts/ledger.ts record <Txx> <setup> <branch>   called by run-setup.sh at start
//   bun scripts/ledger.ts merged <Txx> <mergeSha>
//   bun scripts/ledger.ts sync                            read Entire-Checkpoint trailers on each task branch
//   bun scripts/ledger.ts check                           every merged task: >= 1 checkpoint, prompt tag == setup
//
// env  ROSTER_LEDGER  ledger path (default: <repo>/reports/self/tasks.jsonl)
//      ROSTER_TASKS   task-block file; when set, `record` rebuilds the prompt exactly as run-setup.sh does
//                     and stores its sha256 and tag
//      ROSTER_BASE    base branch for unmerged tasks (default: main)
//
// The file is append-only. Every line is a full snapshot of one task; the last line per task wins.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface LedgerEntry {
  task: string;
  setup: string;
  branch: string;
  started_at: string;
  prompt_sha256: string | null;
  /** First line of the prompt, `[roster setup=<id> task=<Txx>]`. From the session's own prompt once synced. */
  prompt_tag: string | null;
  merge_sha: string | null;
  checkpoint_ids: string[];
  session_ids: string[];
  user_prompts: number;
  human_commits: number;
  event: "record" | "merged" | "sync";
  at: string;
}

export interface Ctx {
  repo: string;
  ledger: string;
  base?: string;
  tasksFile?: string;
  now?: () => Date;
}

const TAG_RE = /^\[roster setup=(\S+) task=(\S+)\]/;
const PROMPT_SEP = "\n\n---\n\n";

export const parseTag = (s: string | null | undefined): { setup: string; task: string } | null => {
  const m = s ? TAG_RE.exec(s.trim()) : null;
  return m ? { setup: m[1] as string, task: m[2] as string } : null;
};

function git(repo: string, args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["git", ...args], { cwd: repo, stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString() };
}

// ---------- ledger file ----------

export function readLedger(path: string): LedgerEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as LedgerEntry);
}

/** Last snapshot per task, in first-seen order. */
export function currentState(entries: LedgerEntry[]): LedgerEntry[] {
  const m = new Map<string, LedgerEntry>();
  for (const e of entries) m.set(e.task, e);
  return [...m.values()];
}

function append(ctx: Ctx, e: LedgerEntry): LedgerEntry {
  mkdirSync(dirname(ctx.ledger), { recursive: true });
  appendFileSync(ctx.ledger, JSON.stringify(e) + "\n");
  return e;
}

const nowIso = (ctx: Ctx) => (ctx.now ? ctx.now() : new Date()).toISOString();

// ---------- prompt reconstruction (mirrors run-setup.sh) ----------

const stripTrailingNl = (s: string) => s.replace(/\n+$/, "");

/** The prompt run-setup.sh sends: tag, guardrails, rest of block. `$(...)` strips trailing newlines. */
export function buildPrompt(tasksText: string, task: string, guardrails: string): string | null {
  const lines = tasksText.split("\n");
  const s = lines.indexOf(`<!-- ${task} -->`);
  if (s < 0) return null;
  const block: string[] = [];
  for (let i = s + 1; i < lines.length && lines[i] !== `<!-- /${task} -->`; i++) block.push(lines[i] as string);
  if (block.length === 0) return null;
  const [tag, ...rest] = block;
  return `${tag}\n\n${stripTrailingNl(guardrails)}\n\n${stripTrailingNl(rest.join("\n"))}`;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------- commands ----------

export function record(ctx: Ctx, task: string, setup: string, branch: string): LedgerEntry {
  let prompt_sha256: string | null = null;
  let prompt_tag: string | null = null;
  if (ctx.tasksFile && existsSync(ctx.tasksFile)) {
    const gPath = join(ctx.repo, "scripts", "guardrails.txt");
    const guard = existsSync(gPath) ? readFileSync(gPath, "utf8") : "";
    const prompt = buildPrompt(readFileSync(ctx.tasksFile, "utf8"), task, guard);
    if (prompt !== null) {
      prompt_sha256 = sha256(prompt);
      prompt_tag = prompt.split("\n", 1)[0] as string;
    }
  }
  const prev = currentState(readLedger(ctx.ledger)).find((e) => e.task === task);
  const at = nowIso(ctx);
  return append(ctx, {
    task,
    setup,
    branch,
    started_at: at,
    prompt_sha256,
    prompt_tag,
    merge_sha: null,
    checkpoint_ids: prev?.branch === branch ? prev.checkpoint_ids : [],
    session_ids: prev?.branch === branch ? prev.session_ids : [],
    user_prompts: 0,
    human_commits: 0,
    event: "record",
    at,
  });
}

export function merged(ctx: Ctx, task: string, mergeSha: string): LedgerEntry {
  const prev = currentState(readLedger(ctx.ledger)).find((e) => e.task === task);
  if (!prev) throw new Error(`ledger: task ${task} was never recorded`);
  const full = git(ctx.repo, ["rev-parse", "--verify", "-q", `${mergeSha}^{commit}`]);
  if (!full.ok) throw new Error(`ledger: ${mergeSha} is not a commit`);
  return append(ctx, { ...prev, merge_sha: full.out.trim(), event: "merged", at: nowIso(ctx) });
}

interface BranchCommit {
  sha: string;
  subject: string;
  checkpoints: string[];
}

/** Commits that belong to the task: the merged side of its merge commit, else branch minus base. */
export function taskCommits(ctx: Ctx, e: LedgerEntry): BranchCommit[] {
  let range: string[];
  if (e.merge_sha && git(ctx.repo, ["rev-parse", "--verify", "-q", `${e.merge_sha}^2`]).ok) {
    range = [`${e.merge_sha}^2`, "--not", `${e.merge_sha}^1`];
  } else if (git(ctx.repo, ["rev-parse", "--verify", "-q", `refs/heads/${e.branch}`]).ok) {
    range = [`refs/heads/${e.branch}`, "--not", ctx.base ?? "main"];
  } else return [];
  const fmt = "%H%x00%s%x00%(trailers:key=Entire-Checkpoint,valueonly,separator=%x2C)%x1e";
  const r = git(ctx.repo, ["log", "--reverse", `--format=${fmt}`, ...range]);
  if (!r.ok) return [];
  return r.out
    .split("\x1e")
    .map((rec) => rec.replace(/^\n+/, ""))
    .filter((rec) => rec !== "")
    .map((rec) => {
      const [sha = "", subject = "", trailers = ""] = rec.split("\x00");
      const checkpoints = trailers
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t !== "");
      return { sha, subject, checkpoints };
    });
}

interface CheckpointSession {
  session_id: string;
  created_at: string;
  prompts: string[];
}

const show = (repo: string, spec: string) => {
  const r = git(repo, ["show", spec]);
  return r.ok ? r.out : null;
};

/** Sessions in one checkpoint, from either storage backend. */
export function readCheckpoint(repo: string, id: string): CheckpointSession[] | null {
  const roots = [`refs/entire/checkpoints/${id.slice(-2)}/${id}:`, `entire/checkpoints/v1:${id.slice(0, 2)}/${id.slice(2)}/`];
  for (const root of roots) {
    const ls = git(repo, ["ls-tree", "--name-only", root]);
    if (!ls.ok) continue;
    const dirs = ls.out
      .split("\n")
      .filter((n) => /^\d+$/.test(n))
      .sort((a, b) => Number(a) - Number(b));
    const out: CheckpointSession[] = [];
    for (const n of dirs) {
      const meta = show(repo, `${root}${n}/metadata.json`);
      let session_id = "";
      let created_at = "";
      if (meta) {
        try {
          const j = JSON.parse(meta);
          session_id = typeof j.session_id === "string" ? j.session_id : "";
          created_at = typeof j.created_at === "string" ? j.created_at : "";
        } catch {}
      }
      const prompt = show(repo, `${root}${n}/prompt.txt`);
      const prompts = prompt ? prompt.split(PROMPT_SEP).filter((p) => p.trim() !== "") : [];
      if (session_id) out.push({ session_id, created_at, prompts });
    }
    // Refs backend: the ref commit message also names the session.
    if (out.length === 0 && root.startsWith("refs/")) {
      const msg = git(repo, ["log", "-1", "--format=%(trailers:key=Entire-Session,valueonly)", root.slice(0, -1)]);
      for (const s of msg.out.split("\n").map((x) => x.trim()).filter(Boolean)) out.push({ session_id: s, created_at: "", prompts: [] });
    }
    return out;
  }
  return null;
}

/** Merge a session's prompt list seen in another checkpoint: cumulative lists replace, slices append. */
function mergePrompts(have: string[], next: string[]): string[] {
  const startsWith = (a: string[], b: string[]) => b.every((x, i) => a[i] === x);
  if (startsWith(next, have)) return next;
  if (startsWith(have, next)) return have;
  return [...have, ...next];
}

export function sync(ctx: Ctx): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const e of currentState(readLedger(ctx.ledger))) {
    const commits = taskCommits(ctx, e);
    const checkpoint_ids = [...new Set(commits.flatMap((c) => c.checkpoints))];
    const sessions = new Map<string, CheckpointSession>();
    for (const id of checkpoint_ids) {
      for (const s of readCheckpoint(ctx.repo, id) ?? []) {
        const have = sessions.get(s.session_id);
        if (!have) sessions.set(s.session_id, { ...s });
        else {
          have.prompts = mergePrompts(have.prompts, s.prompts);
          if (s.created_at && (!have.created_at || s.created_at < have.created_at)) have.created_at = s.created_at;
        }
      }
    }
    const ordered = [...sessions.values()].sort((a, b) => (a.created_at || "~").localeCompare(b.created_at || "~"));
    const sessionTag = ordered.map((s) => s.prompts[0]?.trim().split("\n", 1)[0]).find((p) => parseTag(p));
    const next: LedgerEntry = {
      ...e,
      prompt_tag: sessionTag ?? e.prompt_tag,
      checkpoint_ids,
      session_ids: ordered.map((s) => s.session_id),
      user_prompts: ordered.reduce((n, s) => n + s.prompts.length, 0),
      human_commits: commits.filter((c) => /^human:/.test(c.subject)).length,
      event: "sync",
      at: nowIso(ctx),
    };
    const changed = (["prompt_tag", "checkpoint_ids", "session_ids", "user_prompts", "human_commits"] as const).some(
      (k) => JSON.stringify(next[k]) !== JSON.stringify(e[k]),
    );
    out.push(changed ? append(ctx, next) : e);
  }
  return out;
}

export interface CheckProblem {
  task: string;
  problem: "no_checkpoint" | "no_prompt_tag" | "tag_setup_mismatch" | "tag_task_mismatch";
  detail: string;
}

export function check(ctx: Ctx): CheckProblem[] {
  const problems: CheckProblem[] = [];
  for (const e of currentState(readLedger(ctx.ledger))) {
    if (!e.merge_sha) continue;
    if (e.checkpoint_ids.length === 0) problems.push({ task: e.task, problem: "no_checkpoint", detail: `no Entire-Checkpoint trailer on ${e.branch}` });
    const tag = parseTag(e.prompt_tag);
    if (!tag) problems.push({ task: e.task, problem: "no_prompt_tag", detail: `prompt tag missing or malformed: ${JSON.stringify(e.prompt_tag)}` });
    else {
      if (tag.setup !== e.setup) problems.push({ task: e.task, problem: "tag_setup_mismatch", detail: `tag setup=${tag.setup}, recorded setup=${e.setup}` });
      if (tag.task !== e.task) problems.push({ task: e.task, problem: "tag_task_mismatch", detail: `tag task=${tag.task}, ledger task=${e.task}` });
    }
  }
  return problems;
}

// ---------- CLI ----------

function defaultCtx(): Ctx {
  const top = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const repo = top.ok ? top.out.trim() : process.cwd();
  return {
    repo,
    ledger: process.env.ROSTER_LEDGER || join(repo, "reports", "self", "tasks.jsonl"),
    base: process.env.ROSTER_BASE || "main",
    tasksFile: process.env.ROSTER_TASKS || undefined,
  };
}

const USAGE = "usage: ledger.ts record <Txx> <setup> <branch> | merged <Txx> <mergeSha> | sync | check";

export function main(argv: string[], ctx: Ctx = defaultCtx()): number {
  const [cmd, ...a] = argv;
  try {
    if (cmd === "record" && a.length === 3) console.log(JSON.stringify(record(ctx, a[0]!, a[1]!, a[2]!)));
    else if (cmd === "merged" && a.length === 2) console.log(JSON.stringify(merged(ctx, a[0]!, a[1]!)));
    else if (cmd === "sync" && a.length === 0) for (const e of sync(ctx)) console.log(JSON.stringify(e));
    else if (cmd === "check" && a.length === 0) {
      const problems = check(ctx);
      for (const p of problems) console.error(`ledger check: ${p.task} ${p.problem}: ${p.detail}`);
      const n = currentState(readLedger(ctx.ledger)).filter((e) => e.merge_sha).length;
      console.log(JSON.stringify({ merged_tasks: n, problems }));
      return problems.length === 0 ? 0 : 1;
    } else {
      console.error(USAGE);
      return 2;
    }
    return 0;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
