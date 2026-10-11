// Corpus index: folds every public-repo reports/<owner>__<repo>/review.json into reports/corpus/index.json
// using buildCorpusTable, so the totals are the row sums by construction. Our own repo and _sample are not corpus.
//
// Row cost is the sum of the setups' priced spend_usd (a lower bound when some sessions are unpriced), or null
// when no setup is priced. replayed and promoted are 0 and null: a public review replays nothing.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCorpusTable, type CorpusReview, type CorpusTable } from "../src/review/corpus-table";

export const NOT_CORPUS = ["rajkaria__roster", "_sample"];

export type CorpusIndex = { schemaVersion: 1; generatedAt: string; data: CorpusTable };

type RawSetup = { sessions?: unknown; spend_usd?: unknown };

function toRow(raw: unknown): CorpusReview | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { repo?: unknown; setups?: unknown; suspect?: unknown };
  if (typeof r.repo !== "string" || !Array.isArray(r.setups)) return null;
  const setups = r.setups as RawSetup[];
  const priced = setups.map((s) => s.spend_usd).filter((c): c is number => typeof c === "number");
  return {
    repo: r.repo,
    sessions: setups.reduce((n, s) => n + (typeof s.sessions === "number" ? s.sessions : 0), 0),
    setups: setups.length,
    costUsd: priced.length ? priced.reduce((a, b) => a + b, 0) : null,
    suspect: typeof r.suspect === "string" ? r.suspect : null,
    replayed: 0,
    promoted: null,
  };
}

export function buildCorpusIndex(reportsDir: string, generatedAt: string = new Date().toISOString()): CorpusIndex {
  const rows: CorpusReview[] = [];
  for (const d of readdirSync(reportsDir, { withFileTypes: true })) {
    if (!d.isDirectory() || NOT_CORPUS.includes(d.name) || !d.name.includes("__")) continue;
    try {
      const row = toRow(JSON.parse(readFileSync(join(reportsDir, d.name, "review.json"), "utf8")));
      if (row) rows.push(row);
    } catch {
      // no readable review.json in this dir: not part of the corpus
    }
  }
  return { schemaVersion: 1, generatedAt, data: buildCorpusTable(rows) };
}

export function writeCorpusIndex(reportsDir: string, generatedAt?: string): string {
  const out = join(reportsDir, "corpus", "index.json");
  mkdirSync(join(reportsDir, "corpus"), { recursive: true });
  writeFileSync(out, JSON.stringify(buildCorpusIndex(reportsDir, generatedAt), null, 2) + "\n");
  return out;
}

if (import.meta.main) {
  const dir = process.argv[2] ?? "reports";
  const out = writeCorpusIndex(dir);
  const { totals } = (JSON.parse(readFileSync(out, "utf8")) as CorpusIndex).data;
  console.log(`wrote ${out}: ${totals.repos} repos, ${totals.sessions} sessions`);
}
