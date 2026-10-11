// Generates docs/FACTS.md from reports/. A fact whose source file or path is missing prints PENDING, never a number.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type FactSpec = {
  key: string;
  /** Relative to reports/ (or to the repo root when base is "root"). Directory segments may contain "*". */
  file: string;
  /** "$.a.b[0]" or "$.a[*].b" (every array element), or "re:<regex>" with one capture group for text files. */
  path: string;
  base?: "reports" | "root";
  /** What to do with several values: sum them (numbers) or count them. Default: exactly one value. */
  agg?: "sum" | "count";
  /** Skip matched files that sit under a directory with one of these names. */
  exclude?: string[];
  unit?: string;
  /** Round numbers to this many decimals and say so in the line. */
  decimals?: number;
  /** A path whose values are booleans; when any is true the number is a lower bound and prints with "≥". */
  lowerBound?: string;
  /** Print this when the value is JSON null (instead of PENDING). */
  nullAs?: string;
};

const SELF = "rajkaria__roster/review.json";
const REVIEW1 = "self/review-1/decisions.json";
const FORWARD = "self/forward.json";
const NOT_CORPUS = ["rajkaria__roster", "_sample"];

// Public numbers. Add a spec here before publishing a number anywhere.
export const FACT_SPECS: FactSpec[] = [
  { key: "SELF_SESSIONS", file: SELF, path: "$.setups[*].sessions", agg: "sum", unit: "sessions" },
  { key: "SELF_MATURE", file: SELF, path: "$.setups[*].mature_sessions", agg: "sum", unit: "mature sessions" },
  { key: "SELF_SETUPS", file: SELF, path: "$.setups[*].setup_id", agg: "count", unit: "setups" },
  { key: "SELF_SPEND_USD", file: SELF, path: "$.setups[*].spend_usd", agg: "sum", unit: "USD", decimals: 2, lowerBound: "$.setups[*].spend_lower_bound" },
  { key: "SELF_LABEL", file: SELF, path: "$.label" },
  { key: "SELF_ODDS_RATIO", file: SELF, path: "$.odds_ratio", decimals: 2 },
  { key: "SELF_P", file: SELF, path: "$.p_value", decimals: 3 },
  { key: "CORPUS_REPOS", file: "*/review.json", path: "$.repo", agg: "count", exclude: NOT_CORPUS, unit: "repos" },
  { key: "CORPUS_SESSIONS", file: "*/review.json", path: "$.setups[*].sessions", agg: "sum", exclude: NOT_CORPUS, unit: "sessions" },
  { key: "REVIEW1_OUTCOME", file: REVIEW1, path: "$.outcome" },
  { key: "REVIEW1_PROMOTED", file: REVIEW1, path: "$.promoted", nullAs: "none" },
  { key: "REVIEW1_REPLAYS", file: REVIEW1, path: "$.decisions[*].candidate", agg: "count", unit: "candidate replays gated" },
  { key: "REVIEW1_SPEND_USD", file: REVIEW1, path: "$.spent.total_usd", unit: "USD", decimals: 2 },
  { key: "FORWARD_PAIRS_N", file: FORWARD, path: "$.pairs.n", unit: "pairs" },
  { key: "FORWARD_NEW_ONLY", file: FORWARD, path: "$.mcnemar.new_only", unit: "pairs" },
  { key: "FORWARD_OLD_ONLY", file: FORWARD, path: "$.mcnemar.old_only", unit: "pairs" },
  { key: "FORWARD_P", file: FORWARD, path: "$.mcnemar.p", decimals: 3 },
  { key: "FORWARD_WORDING", file: FORWARD, path: "$.wording" },
  { key: "BACKLOG_SHA256", file: "experiments/FREEZE.txt", base: "root", path: "re:^forward-backlog\\.md\\s+sha256\\s+([0-9a-f]{64})\\s*$" },
];

type Tok = string | number;

function tokens(path: string): Tok[] | undefined {
  if (!path.startsWith("$")) return undefined;
  const out: Tok[] = [];
  for (const m of path.slice(1).matchAll(/\.([^.[\]]+)|\[(\d+|\*)\]/g)) out.push(m[2] !== undefined ? (m[2] === "*" ? "*" : Number(m[2])) : (m[1] as string));
  return out;
}

/** Every value the path reaches; "[*]" fans out over array elements. Empty when the path is not present. */
export function resolve(data: unknown, path: string): unknown[] {
  const toks = tokens(path);
  if (!toks) return [];
  let cur: unknown[] = [data];
  for (const t of toks) {
    const next: unknown[] = [];
    for (const c of cur) {
      if (c === null || typeof c !== "object") continue;
      if (t === "*") {
        if (Array.isArray(c)) next.push(...c);
      } else if (t in c) next.push((c as any)[t]);
    }
    cur = next;
  }
  return cur;
}

export function lookup(data: unknown, path: string): number | string | boolean | undefined {
  if (path.includes("[*]")) return undefined;
  const [v] = resolve(data, path);
  return typeof v === "number" || typeof v === "string" || typeof v === "boolean" ? v : undefined;
}

const segRegex = (seg: string) => new RegExp("^" + seg.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");

/** Expands "*" in path segments against the disk. Returns paths relative to root, sorted. */
export function expand(root: string, file: string): string[] {
  let acc = [""];
  for (const seg of file.split("/")) {
    const next: string[] = [];
    for (const base of acc) {
      const rel = (n: string) => (base ? `${base}/${n}` : n);
      if (!seg.includes("*")) {
        if (existsSync(join(root, rel(seg)))) next.push(rel(seg));
        continue;
      }
      const dir = join(root, base);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
      const rx = segRegex(seg);
      for (const n of readdirSync(dir).sort()) if (rx.test(n)) next.push(rel(n));
    }
    acc = next;
  }
  return acc;
}

/** The printed value, or undefined for PENDING. */
function factValue(root: string, s: FactSpec): string | undefined {
  const files = expand(root, s.file).filter((f) => statSync(join(root, f)).isFile() && !(s.exclude ?? []).some((x) => f.split("/").includes(x)));
  if (files.length === 0) return undefined;
  const values: unknown[] = [];
  const bounds: unknown[] = [];
  for (const f of files) {
    const text = readFileSync(join(root, f), "utf8");
    if (s.path.startsWith("re:")) {
      const m = new RegExp(s.path.slice(3), "m").exec(text);
      if (!m?.[1]) return undefined;
      values.push(m[1]);
      continue;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return undefined;
    }
    const got = resolve(data, s.path);
    // A file missing the path must not silently shrink a total; an existing but empty array contributes nothing.
    const fan = s.path.lastIndexOf("[*]");
    const isEmptyArray = fan >= 0 && resolve(data, s.path.slice(0, fan)).some(Array.isArray);
    if (got.length === 0 && !(isEmptyArray && s.agg)) return undefined;
    values.push(...got);
    if (s.lowerBound) bounds.push(...resolve(data, s.lowerBound));
  }
  let v: unknown;
  if (s.agg === "count") v = values.length;
  else if (s.agg === "sum") {
    if (!values.every((x) => typeof x === "number" && Number.isFinite(x))) return undefined;
    v = (values as number[]).reduce((a, b) => a + b, 0);
  } else {
    if (values.length !== 1) return undefined;
    v = values[0];
    if (v === null) return s.nullAs;
  }
  if (typeof v === "number") {
    const num = s.decimals !== undefined ? v.toFixed(s.decimals) : String(v);
    const lb = bounds.some((b) => b === true) ? "≥" : "";
    const unit = s.unit ? ` ${s.unit}` : "";
    return `${lb}${num}${unit}${s.decimals !== undefined ? `, rounded to ${s.decimals} decimals` : ""}`;
  }
  return typeof v === "string" || typeof v === "boolean" ? String(v) : undefined;
}

export function renderFacts(reportsDir: string, specs: FactSpec[], ts: string): string {
  const lines = specs.map((s) => {
    const root = s.base === "root" ? join(reportsDir, "..") : reportsDir;
    let value: string | undefined;
    try {
      value = factValue(root, s);
    } catch {
      value = undefined;
    }
    const src = `${s.base === "root" ? "" : "reports/"}${s.file}#${s.path}`;
    const ex = s.exclude?.length ? `, excluding ${s.exclude.join(", ")}` : "";
    return `${s.key} = ${value === undefined ? "PENDING" : value}  (source: ${src}${ex}, generated ${ts})`;
  });
  return [
    "<!-- GENERATED by scripts/facts.ts from reports/. Do not edit by hand. -->",
    "# Facts",
    "",
    ...lines,
    "",
  ].join("\n");
}

export function writeFacts(
  reportsDir = "reports",
  out = "docs/FACTS.md",
  specs = FACT_SPECS,
  ts = new Date().toISOString(),
): string {
  const text = renderFacts(reportsDir, specs, ts);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  return text;
}

if (import.meta.main) {
  writeFacts();
  console.log("wrote docs/FACTS.md");
}
