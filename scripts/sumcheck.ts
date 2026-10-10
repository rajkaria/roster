// Recomputes the totals in every reports/**/*.json and exits 1 with a diff on any mismatch.
// Rules (applied to every object found, at any depth):
//   total + by_setup            sum(by_setup) = total
//   n + pass + fail + excluded  pass + fail + excluded = n
//   cost_total_usd + cost_by_setup  sum(cost_by_setup) = cost_total_usd (within 0.005)
//   <k>_pct + <k> + n           <k>_pct = 100 * <k> / n (within 0.1 pt)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type Mismatch = { file: string; path: string; rule: string; expected: number; actual: number };

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function sumOf(v: unknown): number | undefined {
  const vals = Array.isArray(v) ? v : isRecord(v) ? Object.values(v) : undefined;
  if (!vals || vals.length === 0 || !vals.every(isNum)) return undefined;
  return vals.reduce((a, b) => a + b, 0);
}

export function checkReport(file: string, data: unknown): Mismatch[] {
  const out: Mismatch[] = [];
  const add = (path: string, rule: string, expected: number, actual: number, tol: number) => {
    if (Math.abs(expected - actual) > tol) out.push({ file, path, rule, expected, actual });
  };
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) return node.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (!isRecord(node)) return;
    if (isNum(node.total)) {
      const s = sumOf(node.by_setup);
      if (s !== undefined) add(`${path}.total`, "sum(by_setup) = total", s, node.total, 1e-9);
    }
    if (isNum(node.n) && isNum(node.pass) && isNum(node.fail) && isNum(node.excluded)) {
      add(`${path}.n`, "pass + fail + excluded = n", node.pass + node.fail + node.excluded, node.n, 1e-9);
    }
    if (isNum(node.cost_total_usd)) {
      const s = sumOf(node.cost_by_setup);
      if (s !== undefined) {
        add(`${path}.cost_total_usd`, "sum(cost_by_setup) = cost_total_usd", s, node.cost_total_usd, 0.005);
      }
    }
    if (isNum(node.n) && node.n > 0) {
      for (const [k, v] of Object.entries(node)) {
        if (!k.endsWith("_pct") || !isNum(v)) continue;
        const base = k.slice(0, -4);
        const count = node[base];
        if (isNum(count)) add(`${path}.${k}`, `${k} = 100 * ${base} / n (within 0.1 pt)`, (100 * count) / node.n, v, 0.1);
      }
    }
    for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
  };
  walk(data, "$");
  return out;
}

function listJson(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.sort().flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return listJson(p);
    return e.endsWith(".json") ? [p] : [];
  });
}

export function sumcheck(reportsDir: string): { files: number; mismatches: Mismatch[] } {
  const files = listJson(reportsDir);
  const mismatches = files.flatMap((f) => {
    try {
      return checkReport(f, JSON.parse(readFileSync(f, "utf8")));
    } catch (e) {
      return [{ file: f, path: "$", rule: `unreadable JSON: ${(e as Error).message}`, expected: 0, actual: 0 }];
    }
  });
  return { files: files.length, mismatches };
}

export function formatDiff(ms: Mismatch[]): string {
  return ms
    .map((m) => `${m.file} ${m.path}\n  rule:     ${m.rule}\n- expected: ${m.expected}\n+ actual:   ${m.actual}`)
    .join("\n");
}

if (import.meta.main) {
  const dir = process.argv[2] ?? "reports";
  const { files, mismatches } = sumcheck(dir);
  if (mismatches.length) {
    console.error(formatDiff(mismatches));
    console.error(`\nsumcheck FAILED: ${mismatches.length} mismatch(es) in ${files} file(s)`);
    process.exit(1);
  }
  console.log(`sumcheck ok: ${files} file(s) in ${dir}`);
}
