// Graph impact size for a session (DESIGN.md §"Difficulty and review"). Primary method: spawn
// `entire graph impact --symbol <s> --format json` for the symbols declared in the touched hunks of
// the session's commit, and sum caller and type-consumer counts. When entire is not installed or
// fails, fall back to the import fan-in of the touched files. The method used is always returned.

import { dirname, join, normalize } from "node:path";

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
  const p = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString() };
}

const DECL =
  /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/;

/** Names declared on the added lines of `sha`'s diff, in diff order, deduplicated. */
export function symbolsInHunks(repo: string, sha: string): string[] {
  const r = git(repo, ["show", "--unified=0", "--format=", "--no-color", "--no-renames", sha]);
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
  const counts = new Map<string, number>();
  const grep = git(repo, ["grep", "-I", "-E", "(from|import|require)", "HEAD", "--", "*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs", "*.mts", "*.cts"]);
  const importers = new Map<string, Set<string>>();
  for (const line of grep.out.split("\n")) {
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
  fanInCache.set(key, counts);
  return counts;
}

export function fanInSize(repo: string, files: string[]): number {
  const counts = importFanIn(repo);
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
