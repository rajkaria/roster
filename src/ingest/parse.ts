// Parse Entire checkpoints into Session rows. See docs/DESIGN.md §"Entire checkpoint format" and §"Ingest".
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { Session, SessionSource } from "../types";

export type Backend = SessionSource | "auto";

/** Where tokens and model came from. Session.source is the storage backend, so this lives beside it. */
export type UsageSource = "metadata" | "transcript" | "none";

export interface ParsedSession extends Session {
  usage_source: UsageSource;
  model_source: "metadata" | "transcript" | "none";
}

export interface ParseOptions {
  warn?: (msg: string) => void;
}

const BRANCH_REFS = ["refs/heads/entire/checkpoints/v1", "refs/remotes/origin/entire/checkpoints/v1"];
const PROMPT_SEP = "\n\n---\n\n";

function git(repo: string, args: string[]): string | null {
  const p = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  return p.exitCode === 0 ? p.stdout.toString() : null;
}

/** A checkpoint's files, keyed by path relative to the checkpoint root. */
interface RawCheckpoint {
  id: string;
  source: SessionSource;
  read: (path: string) => string | null;
  paths: string[];
}

function makeReader(repo: string, treeish: string, prefix: string) {
  return (path: string) => git(repo, ["show", `${treeish}:${prefix}${path}`]);
}

function listBranch(repo: string): RawCheckpoint[] {
  for (const ref of BRANCH_REFS) {
    const out = git(repo, ["ls-tree", "-r", "--name-only", ref]);
    if (!out) continue;
    const byId = new Map<string, string[]>();
    for (const p of out.split("\n").filter(Boolean)) {
      const m = /^([0-9a-f]{2})\/([^/]+)\/(.+)$/.exec(p);
      if (!m) continue;
      const id = m[1]! + m[2]!;
      (byId.get(id) ?? byId.set(id, []).get(id)!).push(m[3]!);
    }
    if (byId.size === 0) continue;
    return [...byId].map(([id, paths]) => ({
      id,
      source: "branch" as const,
      paths,
      read: makeReader(repo, ref, `${id.slice(0, 2)}/${id.slice(2)}/`),
    }));
  }
  return [];
}

function listRefs(repo: string): RawCheckpoint[] {
  const out = git(repo, ["for-each-ref", "--format=%(refname)", "refs/entire/checkpoints/"]);
  if (!out) return [];
  const res: RawCheckpoint[] = [];
  for (const ref of out.split("\n").filter(Boolean)) {
    const tree = git(repo, ["ls-tree", "-r", "--name-only", ref]);
    if (tree === null) continue;
    res.push({
      id: ref.split("/").pop()!,
      source: "git-refs",
      paths: tree.split("\n").filter(Boolean),
      read: makeReader(repo, ref, ""),
    });
  }
  return res;
}

/** checkpoint id → [commit sha, unix time] of the earliest commit carrying its trailer, on any branch. */
function mapCommits(repo: string): Map<string, string> {
  const out = git(repo, ["log", "--all", "--format=%H%x1f%ct%x1f%(trailers:key=Entire-Checkpoint,valueonly,separator=%x2c)%x1e"]);
  const best = new Map<string, { sha: string; t: number }>();
  for (const rec of (out ?? "").split("\x1e")) {
    const [sha, ct, ids] = rec.trim().split("\x1f");
    if (!sha || !ids) continue;
    for (const id of ids.split(",").map((s) => s.trim()).filter(Boolean)) {
      const t = Number(ct);
      const cur = best.get(id);
      if (!cur || t < cur.t) best.set(id, { sha, t });
    }
  }
  return new Map([...best].map(([id, v]) => [id, v.sha]));
}

function githubUrlBase(repo: string): { owner: string; name: string } | null {
  const url = git(repo, ["remote", "get-url", "origin"])?.trim() ?? "";
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  return m ? { owner: m[1]!, name: m[2]! } : null;
}

type Json = Record<string, any>;

function jsonl(text: string | null): Json[] {
  if (!text) return [];
  const rows: Json[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // transcripts are best-effort; skip torn lines
    }
  }
  return rows;
}

const cleanModel = (m: string) => m.replace(/\[[^\]]*\]$/, "");
const WRAPPER_RE = /<(task-notification|system-reminder)\b[^>]*>[\s\S]*?<\/\1>/g;
/** A user row's text minus injected wrappers (background-task notifications, system reminders). */
const stripInjected = (s: string) => s.replace(WRAPPER_RE, "").trim();

/** Project/Local rules files in an instructions or nested_memory attachment. */
function attachedRules(a: Json): { path: string; content: string }[] {
  const cands: Json[] = Array.isArray(a.files) ? [...a.files] : [];
  if (a.content && typeof a.content === "object") cands.push(a.content);
  if (typeof a.path === "string" && typeof a.content === "string") cands.push(a);
  return cands
    .filter((f) => (f.type === "Project" || f.type === "Local") && typeof f.path === "string" && typeof f.content === "string")
    .map((f) => ({ path: f.path as string, content: f.content as string }));
}

function relToCwd(path: string, cwd: string | null): string {
  const root = cwd?.replace(/\/+$/, "");
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return path.replace(/^<repo>\//, "");
}

const hashRules = (s: string) => createHash("sha256").update(s.replace(/\r\n/g, "\n").trim()).digest("hex");

interface TranscriptInfo {
  model: string | null;
  rules_hash: string | null;
  tokens: { in: number; out: number; cr: number; cw: number } | null;
  prompts: string[];
  first_ts: string | null;
  last_ts: string | null;
}

function readTranscript(rows: Json[]): TranscriptInfo {
  let model: string | null = null;
  let attachedModel: string | null = null;
  let rules: string | null = null;
  let cwd: string | null = null;
  const files = new Map<string, string>();
  const sum = { in: 0, out: 0, cr: 0, cw: 0 };
  let sawClaudeUsage = false;
  let codexTotal: Json | null = null;
  const prompts: string[] = [];
  const ts: string[] = [];

  for (const r of rows) {
    if (typeof r.timestamp === "string") ts.push(r.timestamp);
    if (cwd === null && typeof r.cwd === "string" && r.cwd) cwd = r.cwd;
    if (r.type === "attachment") {
      const a = r.attachment ?? {};
      if (a.type === "model" && a.identity?.modelId) attachedModel ??= cleanModel(String(a.identity.modelId));
      if (a.type === "instructions" || a.type === "nested_memory") {
        // paths are made cwd-relative after the whole transcript is read, once cwd is known
        for (const f of attachedRules(a)) files.set(f.path, f.content);
      }
    } else if (r.type === "assistant" && r.message) {
      if (typeof r.message.model === "string" && r.message.model && r.message.model !== "<synthetic>") model ??= r.message.model;
      const u = r.message.usage;
      if (u) {
        sawClaudeUsage = true;
        sum.in += u.input_tokens ?? 0;
        sum.out += u.output_tokens ?? 0;
        sum.cr += u.cache_read_input_tokens ?? 0;
        sum.cw += u.cache_creation_input_tokens ?? 0;
      }
    } else if (r.type === "user" && r.message && !r.isMeta && !r.isCompactSummary && !r.isSidechain) {
      // tool results and approvals arrive as user rows holding tool_result blocks; they are not prompts
      const c = r.message.content;
      const text =
        typeof c === "string"
          ? c
          : Array.isArray(c) && !c.some((b: Json) => b.type === "tool_result")
            ? c.filter((b: Json) => b.type === "text").map((b: Json) => b.text).join("\n")
            : "";
      const real = stripInjected(text);
      if (real) prompts.push(real);
    } else if (r.type === "turn_context") {
      if (typeof r.payload?.model === "string" && r.payload.model) model ??= r.payload.model;
    } else if (r.type === "world_state") {
      const md = r.payload?.state?.agents_md;
      if (rules === null && typeof md === "string" && md) rules = hashRules(md);
    } else if (r.type === "event_msg") {
      const p = r.payload ?? {};
      if (p.type === "token_count" && p.info?.total_token_usage) codexTotal = p.info.total_token_usage;
      if (p.type === "user_message" && typeof p.message === "string" && p.message.trim()) prompts.push(p.message.trim());
    }
  }

  if (files.size) {
    const rel = new Map<string, string>();
    for (const [path, content] of files) rel.set(relToCwd(path, cwd), content.replace(/\r\n/g, "\n").trim());
    // paths only fix the order, so a lone CLAUDE.md keeps its content-only hash
    const body = [...rel].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, c]) => c);
    rules = hashRules(body.join("\n"));
  }

  let tokens: TranscriptInfo["tokens"] = null;
  if (sawClaudeUsage) tokens = sum;
  else if (codexTotal) {
    const cached = codexTotal.cached_input_tokens ?? 0;
    tokens = {
      in: Math.max(0, (codexTotal.input_tokens ?? 0) - cached), // Entire's input excludes cached input
      out: codexTotal.output_tokens ?? 0,
      cr: cached,
      cw: codexTotal.cache_write_input_tokens ?? 0,
    };
  }
  ts.sort();
  return { model: attachedModel ?? model, rules_hash: rules, tokens, prompts, first_ts: ts[0] ?? null, last_ts: ts.at(-1) ?? null };
}

/** One session's slice inside one checkpoint. */
interface Slice {
  session_id: string;
  checkpoint_id: string;
  source: SessionSource;
  agent: string;
  model: string | null;
  model_from_meta: boolean;
  rules_hash: string | null;
  tokens: { in: number; out: number; cr: number; cw: number } | null;
  usage_source: UsageSource;
  prompts: string[];
  files: string[];
  start: string;
  end: string;
}

function parseCheckpoint(cp: RawCheckpoint): Slice[] {
  const need = (path: string): Json => {
    const t = cp.read(path);
    if (t === null) throw new Error(`missing ${path}`);
    return JSON.parse(t);
  };
  const root = need("metadata.json");
  const indices = new Set<string>();
  for (const p of cp.paths) {
    const m = /^(\d+)\/metadata\.json$/.exec(p);
    if (m) indices.add(m[1]!);
  }
  if (indices.size === 0) throw new Error("no session metadata");
  const ordered = [...indices].sort((a, b) => Number(a) - Number(b));

  // subagent transcripts: attach to the parent session (the only/first session of the checkpoint)
  const taskRows = cp.paths
    .filter((p) => /^tasks\/[^/]+\/agent-[^/]+\.jsonl$/.test(p))
    .flatMap((p) => jsonl(cp.read(p)));

  const slices: Slice[] = [];
  ordered.forEach((n, i) => {
    const meta = need(`${n}/metadata.json`);
    if (typeof meta.session_id !== "string" || !meta.session_id) throw new Error(`${n}/metadata.json has no session_id`);
    const hasTranscript = cp.paths.includes(`${n}/full.jsonl`);
    const tr = readTranscript(jsonl(hasTranscript ? cp.read(`${n}/full.jsonl`) : null));
    const promptTxt = cp.paths.includes(`${n}/prompt.txt`) ? cp.read(`${n}/prompt.txt`) : null;
    const prompts = promptTxt !== null ? promptTxt.split(PROMPT_SEP).map((s) => s.trim()).filter(Boolean) : tr.prompts;

    const mu = meta.token_usage;
    let tokens: Slice["tokens"] = null;
    let usage_source: UsageSource = "none";
    if (mu && typeof mu === "object") {
      tokens = { in: mu.input_tokens ?? 0, out: mu.output_tokens ?? 0, cr: mu.cache_read_tokens ?? 0, cw: mu.cache_creation_tokens ?? 0 };
      usage_source = "metadata";
    } else if (tr.tokens) {
      tokens = { ...tr.tokens };
      usage_source = "transcript";
      if (i === 0 && taskRows.length) {
        const sub = readTranscript(taskRows).tokens;
        if (sub) {
          tokens.in += sub.in;
          tokens.out += sub.out;
          tokens.cr += sub.cr;
          tokens.cw += sub.cw;
        }
      }
    }
    const created = typeof meta.created_at === "string" ? meta.created_at : "";
    slices.push({
      session_id: meta.session_id,
      checkpoint_id: String(meta.checkpoint_id ?? root.checkpoint_id ?? cp.id),
      source: cp.source,
      agent: String(meta.agent ?? "unknown"),
      model: typeof meta.model === "string" && meta.model ? meta.model : tr.model,
      model_from_meta: typeof meta.model === "string" && !!meta.model,
      rules_hash: tr.rules_hash,
      tokens,
      usage_source,
      prompts,
      files: Array.isArray(meta.files_touched) ? meta.files_touched.map(String) : [],
      start: [created, tr.first_ts].filter(Boolean).sort()[0] ?? "",
      end: [created, tr.last_ts].filter(Boolean).sort().at(-1) ?? "",
    });
  });
  return slices;
}

const normPrompt = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * A session spanning several checkpoints repeats its prompts in each slice. Its prompts are the ordered union of
 * distinct prompts: compare normalised text, keep first-occurrence order. A text seen k times within one slice is k
 * distinct prompts, so the union keeps the largest per-slice multiplicity rather than collapsing repeats like "yes".
 */
export function unionPrompts(slices: string[][]): string[] {
  const kept = new Map<string, number>();
  const out: string[] = [];
  for (const prompts of slices) {
    const seen = new Map<string, number>();
    for (const p of prompts) {
      const k = normPrompt(p);
      const n = (seen.get(k) ?? 0) + 1;
      seen.set(k, n);
      if (n > (kept.get(k) ?? 0)) {
        kept.set(k, n);
        out.push(p);
      }
    }
  }
  return out;
}

/** Parse every checkpoint in `repoPath` into one Session per agent session id. */
export function parseCheckpoints(repoPath: string, backend: Backend = "auto", opts: ParseOptions = {}): ParsedSession[] {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  let cps: RawCheckpoint[] = [];
  if (backend === "branch" || backend === "auto") cps = listBranch(repoPath);
  if (backend === "git-refs" || (backend === "auto" && cps.length === 0)) cps = cps.concat(listRefs(repoPath));

  const commits = mapCommits(repoPath);
  const gh = githubUrlBase(repoPath);
  const repoName = gh ? `${gh.owner}/${gh.name}` : basename(repoPath);

  const slices: Slice[] = [];
  for (const cp of cps.sort((a, b) => a.id.localeCompare(b.id))) {
    try {
      slices.push(...parseCheckpoint(cp));
    } catch (e) {
      warn(`skipping checkpoint ${cp.id}: ${(e as Error).message}`);
    }
  }

  const bySession = new Map<string, Slice[]>();
  for (const s of slices) (bySession.get(s.session_id) ?? bySession.set(s.session_id, []).get(s.session_id)!).push(s);

  const sessions: ParsedSession[] = [];
  for (const [id, group] of bySession) {
    group.sort((a, b) => a.start.localeCompare(b.start));
    const first = group[0]!;
    const withTokens = group.filter((g) => g.tokens);
    const sum = (k: "in" | "out" | "cr" | "cw") => withTokens.reduce((n, g) => n + g.tokens![k], 0);
    const usageSources = new Set(withTokens.map((g) => g.usage_source));
    const modelSlice = group.find((g) => g.model);
    const model = modelSlice?.model ?? "unknown";
    // commit: earliest-created checkpoint of this session that has a trailer-linked commit
    const commit = group.map((g) => commits.get(g.checkpoint_id)).find(Boolean) ?? null;
    const prompts = unionPrompts(group.map((g) => g.prompts));
    sessions.push({
      id,
      repo: repoName,
      checkpoint_id: first.checkpoint_id,
      harness: first.agent,
      model,
      rules_hash: group.find((g) => g.rules_hash)?.rules_hash ?? null,
      setup_id: null,
      tokens_in: sum("in"),
      tokens_out: sum("out"),
      cache_read: sum("cr"),
      cache_write: sum("cw"),
      cost_usd: null,
      n_user_prompts: prompts.length,
      first_prompt: prompts[0] ?? "",
      commit_sha: commit,
      started_at: group.map((g) => g.start).filter(Boolean).sort()[0] ?? "",
      ended_at: group.map((g) => g.end).filter(Boolean).sort().at(-1) ?? "",
      files: [...new Set(group.flatMap((g) => g.files))].sort(),
      entire_url: gh ? `https://entire.io/gh/${gh.owner}/${gh.name}/session/${id}` : null,
      source: first.source,
      usage_source: usageSources.size === 0 ? "none" : usageSources.size === 1 ? [...usageSources][0]! : "transcript",
      model_source: !modelSlice ? "none" : modelSlice.model_from_meta ? "metadata" : "transcript",
    });
  }
  return sessions.sort((a, b) => a.started_at.localeCompare(b.started_at) || a.id.localeCompare(b.id));
}
