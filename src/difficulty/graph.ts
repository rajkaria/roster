// Graph impact size for a session (DESIGN.md §"Difficulty and review"). Primary method: spawn
// `entire graph impact --symbol <s> --format json` for the symbols declared in the touched hunks of
// the session's commit, and sum caller and type-consumer counts. When entire is not installed or
// fails, fall back to the import fan-in of the touched files. The method used is always returned.
// A review goes through GraphQueue instead, which bounds and caches the spawns and records why it fell back.

import { dirname, join, normalize } from "node:path";
import { GIT_TIMEOUT_MS, type GitRunner } from "../score/rework.ts";

export type ImpactMethod = "graph" | "fan-in";

export interface ImpactResult {
  size: number;
  method: ImpactMethod;
  /** Symbols queried with the graph; empty for fan-in. */
  symbols: string[];
}

export interface GraphOptions {
  /** Binary to spawn; default `entire` from PATH. */
  entireBin?: string;
  /** Per-call timeout in ms. */
  timeoutMs?: number;
  /** Max symbols queried per session. */
  maxSymbols?: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_SYMBOLS = 8;

function git(repo: string, args: string[]): { ok: boolean; out: string } {
  const p = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: GIT_TIMEOUT_MS, killSignal: "SIGKILL" });
  return { ok: p.exitCode === 0, out: p.stdout.toString() };
}

const DECL =
  /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/;

/** Names declared on the added lines of `sha`'s diff, in diff order, deduplicated. */
export function symbolsInHunks(repo: string, sha: string): string[] {
  return parseSymbols(git(repo, [...SHOW_HUNKS, sha]));
}

async function symbolsInHunksAsync(run: GitRunner, repo: string, sha: string): Promise<string[]> {
  return parseSymbols(await run(repo, [...SHOW_HUNKS, sha]));
}

const SHOW_HUNKS = ["show", "--unified=0", "--format=", "--no-color", "--no-renames"];

function parseSymbols(r: { ok: boolean; out: string }): string[] {
  if (!r.ok) return [];
  const seen = new Set<string>();
  for (const line of r.out.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const m = DECL.exec(line.slice(1));
    if (m?.[1]) seen.add(m[1]);
  }
  return [...seen];
}

/** Callers plus type consumers in one `entire graph impact` JSON reply; null when it is not one. */
export function parseImpact(json: string): number | null {
  try {
    const j = JSON.parse(json) as {
      disambiguation_required?: boolean;
      focus?: unknown;
      callers?: { total?: number };
      type_consumers?: { total?: number };
    };
    if (!j || typeof j !== "object" || !j.focus) return null;
    return (j.callers?.total ?? 0) + (j.type_consumers?.total ?? 0);
  } catch {
    return null;
  }
}

/** One spawned impact query. `null` = the graph could not answer (missing binary, timeout, error). */
export function graphImpact(repo: string, symbol: string, opts: GraphOptions = {}): number | null {
  const bin = opts.entireBin ?? "entire";
  let p: ReturnType<typeof Bun.spawnSync>;
  try {
    p = Bun.spawnSync(
      [bin, "graph", "impact", "--repo", repo, "--symbol", symbol, "--format", "json", "--depth", "2"],
      { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    );
  } catch {
    return null;
  }
  if (p.exitCode !== 0 || !p.stdout) return null;
  return parseImpact(p.stdout.toString());
}

// ---------- bounded graph calls for one review ----------

/** Why a session fell back to fan-in after asking the graph. */
export type ImpactFallback = "unavailable" | "timeout" | "budget";

export const REVIEW_TIMEOUT_MS = 10_000;
export const GRAPH_PARALLEL = 4;

type Answer = { n: number } | { fallback: ImpactFallback };

/**
 * `entire graph impact` for one review: at most `maxCalls` spawns in all (the review passes one per
 * touched file), `concurrency` at once, each killed after `timeoutMs`. Every symbol is asked once and
 * the answer, or the reason there is none, is cached.
 */
export class GraphQueue {
  readonly bin: string;
  readonly timeoutMs: number;
  readonly concurrency: number;
  maxCalls: number;
  /** Spawned calls so far, most in flight at once, and symbols that timed out. */
  calls = 0;
  peak = 0;
  timedOut: string[] = [];
  private active = 0;
  private waiting: (() => void)[] = [];
  private cache = new Map<string, Promise<Answer>>();
  private missing = false;

  constructor(
    readonly repo: string,
    opts: GraphOptions & { maxCalls: number; concurrency?: number },
  ) {
    this.bin = opts.entireBin ?? "entire";
    this.timeoutMs = opts.timeoutMs ?? REVIEW_TIMEOUT_MS;
    this.concurrency = opts.concurrency ?? GRAPH_PARALLEL;
    this.maxCalls = opts.maxCalls;
  }

  impact(symbol: string): Promise<Answer> {
    let p = this.cache.get(symbol);
    if (!p) {
      p = this.ask(symbol);
      this.cache.set(symbol, p);
    }
    return p;
  }

  private async ask(symbol: string): Promise<Answer> {
    if (this.calls >= this.maxCalls) return { fallback: "budget" };
    this.calls++;
    if (this.active >= this.concurrency) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    try {
      return await this.spawn(symbol);
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  private async spawn(symbol: string): Promise<Answer> {
    if (this.missing) return { fallback: "unavailable" };
    let p: ReturnType<typeof Bun.spawn>;
    try {
      p = Bun.spawn([this.bin, "graph", "impact", "--repo", this.repo, "--symbol", symbol, "--format", "json", "--depth", "2"], {
        cwd: this.repo,
        stdout: "pipe",
        stderr: "ignore",
      });
    } catch {
      this.missing = true;
      return { fallback: "unavailable" };
    }
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      p.kill();
    }, this.timeoutMs);
    try {
      const [out, code] = await Promise.all([new Response(p.stdout as ReadableStream).text(), p.exited]);
      if (late) {
        this.timedOut.push(symbol);
        return { fallback: "timeout" };
      }
      const n = code === 0 ? parseImpact(out) : null;
      return n === null ? { fallback: "unavailable" } : { n };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * `impactSize` for every session of a review, through its GraphQueue and git runner, with the same
 * answers. Symbols are found first and queued in session order, so which sessions the call budget
 * covers does not depend on timing. Records why a session fell back, if it asked the graph.
 */
export async function impactSizes(
  queue: GraphQueue,
  run: GitRunner,
  sessions: { sha: string | null; files: string[] }[],
  maxSymbols: number = DEFAULT_MAX_SYMBOLS,
): Promise<(ImpactResult & { fallback: ImpactFallback | null })[]> {
  const repo = queue.repo;
  const symbols = await Promise.all(
    sessions.map(async (s) => (s.sha ? (await symbolsInHunksAsync(run, repo, s.sha)).slice(0, maxSymbols) : [])),
  );
  const answers = symbols.map((list) => list.map((s) => queue.impact(s)));
  return Promise.all(
    sessions.map(async (s, i) => {
      let fallback: ImpactFallback | null = null;
      if (symbols[i]!.length > 0) {
        let size = 0;
        for (const p of answers[i]!) {
          const a = await p;
          if ("fallback" in a) {
            fallback = a.fallback;
            break;
          }
          size += a.n;
        }
        if (fallback === null) return { size, method: "graph" as const, symbols: symbols[i]!, fallback };
      }
      return { size: await fanInSizeAsync(run, repo, s.files), method: "fan-in" as const, symbols: [], fallback };
    }),
  );
}

// ---------- fallback: import fan-in ----------

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const stripExt = (p: string) => p.replace(SOURCE, "").replace(/\/index$/, "");

const fanInCache = new Map<string, Map<string, number>>();

/** Module (path without extension) → number of distinct files at HEAD that import it relatively. */
export function importFanIn(repo: string): Map<string, number> {
  const head = git(repo, ["rev-parse", "HEAD"]).out.trim();
  const key = `${repo}@${head}`;
  const cached = fanInCache.get(key);
  if (cached) return cached;
  const counts = parseFanIn(git(repo, GREP_IMPORTS).out);
  fanInCache.set(key, counts);
  return counts;
}

const GREP_IMPORTS = ["grep", "-I", "-E", "(from|import|require)", "HEAD", "--", "*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs", "*.mts", "*.cts"];
const fanInPending = new Map<string, Promise<Map<string, number>>>();

/** `importFanIn` through a runner; sessions scored at once share one grep per HEAD. */
async function importFanInAsync(run: GitRunner, repo: string): Promise<Map<string, number>> {
  const key = `${repo}@${(await run(repo, ["rev-parse", "HEAD"])).out.trim()}`;
  const cached = fanInCache.get(key);
  if (cached) return cached;
  let p = fanInPending.get(key);
  if (!p) {
    p = run(repo, GREP_IMPORTS).then((r) => {
      const counts = parseFanIn(r.out);
      fanInCache.set(key, counts);
      fanInPending.delete(key);
      return counts;
    });
    fanInPending.set(key, p);
  }
  return p;
}

async function fanInSizeAsync(run: GitRunner, repo: string, files: string[]): Promise<number> {
  return sumFanIn(await importFanInAsync(run, repo), files);
}

function parseFanIn(out: string): Map<string, number> {
  const counts = new Map<string, number>();
  const importers = new Map<string, Set<string>>();
  for (const line of out.split("\n")) {
    // `HEAD:path:content`
    const m = /^HEAD:([^:]+):(.*)$/.exec(line);
    if (!m) continue;
    const [, file, content] = m as unknown as [string, string, string];
    for (const im of content.matchAll(IMPORT)) {
      const target = stripExt(normalize(join(dirname(file), im[1]!)));
      if (target === stripExt(file)) continue;
      let set = importers.get(target);
      if (!set) importers.set(target, (set = new Set()));
      set.add(file);
    }
  }
  for (const [t, s] of importers) counts.set(t, s.size);
  return counts;
}

export function fanInSize(repo: string, files: string[]): number {
  return sumFanIn(importFanIn(repo), files);
}

function sumFanIn(counts: Map<string, number>, files: string[]): number {
  return files.reduce((sum, f) => sum + (counts.get(stripExt(normalize(f))) ?? 0), 0);
}

// ---------- per session ----------

/**
 * Impact size of a session's change. Graph when entire answers for every queried symbol; otherwise
 * fan-in over `files`. A session with no commit or no declared symbols uses fan-in.
 */
export function impactSize(repo: string, sha: string | null, files: string[], opts: GraphOptions = {}): ImpactResult {
  const symbols = sha ? symbolsInHunks(repo, sha).slice(0, opts.maxSymbols ?? DEFAULT_MAX_SYMBOLS) : [];
  if (symbols.length > 0) {
    let size = 0;
    let ok = true;
    for (const s of symbols) {
      const n = graphImpact(repo, s, opts);
      if (n === null) {
        ok = false;
        break;
      }
      size += n;
    }
    if (ok) return { size, method: "graph", symbols };
  }
  return { size: fanInSize(repo, files), method: "fan-in", symbols: [] };
}
