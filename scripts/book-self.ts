// Books this repo's AI team. Reads the published review (reports/rajkaria__roster/review.json and its
// sessions.json), builds the AI-workforce book with src/cfo/book.ts and writes reports/self/book.json for the
// /book page. With --write it also writes the book into cfo.ai through the MCP bridge (src/cfo/client.ts),
// reads it back, and records the outcome under `cfo`. The book's read-only share link comes from
// reports/self/cfo-plan.json `shareUrls.book`, created in cfo.ai's Share panel.
//
//   bun scripts/book-self.ts [--write]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildBook, type BookInput, type BookOutput } from "../src/cfo/book";
import { createCfoClient, type CfoClient } from "../src/cfo/client";
import { writeBook } from "../src/cfo/mcp";
import { loadSetups, type RunnableSetup } from "../src/setups/registry";

const ROOT = join(import.meta.dir, "..");
const DAY_MS = 86_400_000;

/** Assumptions, not measurements: the book labels them as such. */
export const ASSUMPTIONS: BookInput["assumptions"] = {
  engineerMonthlyLoadedUsd: 12_000,
  scaleSessionsPerWeek: 50,
};
export const ASSUMPTION_LABELS: Record<keyof BookInput["assumptions"], string> = {
  engineerMonthlyLoadedUsd: "assumption: one engineer's loaded monthly cost, in USD",
  scaleSessionsPerWeek: "assumption: sessions per week the promoted setup would run at scale",
};

type ReviewSetup = {
  setup_id: string;
  label: string;
  harness?: string;
  model?: string;
  sessions: number;
  spend_usd: number | null;
  spend_lower_bound?: boolean;
  unattended: number | null;
  surviving_changes: number | null;
};
type Review = {
  id: string;
  repo: string;
  setups: ReviewSetup[];
  tags?: { by_tag?: Record<string, { sessions: number; setup_ids: string[] }> };
};
type Session = { setup_id?: string; started_at?: string | null; ended_at?: string | null };

export type CfoOutcome = { written: boolean; verified: boolean; error: string | null };

export type BookFile = BookOutput & {
  source: { review: string; repo: string };
  period: { from: string; to: string; days: number };
  promoted: { id: string | null; source: string | null; note: string | null; matchedBy: "id" | "tag" | "model" | null };
  assumptionLabels: Record<string, string>;
  notes: string[];
  shareUrl: string | null;
  cfo: CfoOutcome;
};

/** The review's session date range: earliest start to latest end. */
export function sessionPeriod(sessions: Session[]): BookFile["period"] {
  const times = sessions
    .flatMap((s) => [s.started_at, s.ended_at])
    .filter((t): t is string => typeof t === "string")
    .map((t) => Date.parse(t))
    .filter(Number.isFinite);
  if (times.length === 0) throw new Error("no session timestamps in the review");
  const from = Math.min(...times);
  const to = Math.max(...times);
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), days: (to - from) / DAY_MS };
}

type Definition = Pick<RunnableSetup, "id" | "harness" | "model">;
const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");

/**
 * The review setup for a promotion. A promotion names a definition id (setups/*.json); the review's setups are
 * hashed ids. Order: the review's own id, the review's prompt-tag map (most sessions wins), then the one setup with
 * the definition's model and harness. Otherwise the promotion is unmeasured and cannot be scaled.
 */
function promotedOf(review: Review, promotion: { promoted?: unknown } | null, definitions: Definition[]): BookFile["promoted"] {
  const id = typeof promotion?.promoted === "string" ? promotion.promoted : null;
  if (id === null) return { id: null, source: null, note: "no promotion record", matchedBy: null };
  const find = (sid: string) => review.setups.find((s) => s.setup_id === sid);
  if (find(id)) return { id, source: id, note: null, matchedBy: "id" };

  const tagged = (review.tags?.by_tag?.[id]?.setup_ids ?? []).filter((sid) => find(sid));
  if (tagged.length > 0) {
    const top = tagged.reduce((best, sid) => ((find(sid)?.sessions ?? 0) > (find(best)?.sessions ?? 0) ? sid : best));
    return { id: top, source: id, note: null, matchedBy: "tag" };
  }

  const def = definitions.find((d) => d.id === id);
  const same = def ? review.setups.filter((s) => s.model === def.model && norm(s.harness ?? "") === norm(def.harness)) : [];
  if (same.length === 1) return { id: same[0]!.setup_id, source: id, note: null, matchedBy: "model" };

  return {
    id: null,
    source: id,
    note: `promoted setup ${id} has no sessions in this review, so the scale scenario has no rate`,
    matchedBy: null,
  };
}

/** The book's share link from cfo-plan.json, kept only when it is an https URL on cfo.ai (as /book requires). */
export function shareUrlFromPlan(plan: unknown): string | null {
  const v = (plan as { shareUrls?: { book?: unknown } } | null)?.shareUrls?.book;
  if (typeof v !== "string") return null;
  try {
    const url = new URL(v);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (host === "cfo.ai" || host.endsWith(".cfo.ai")) ? v : null;
  } catch {
    return null;
  }
}

export function bookFromReview(
  review: Review,
  sessions: Session[],
  promotion: { promoted?: unknown } | null,
  reviewPath: string,
  definitions: Definition[] = [],
  shareUrl: string | null = null,
): BookFile {
  const period = sessionPeriod(sessions);
  if (period.days <= 0) throw new Error("the review's sessions span no time");
  const promoted = promotedOf(review, promotion, definitions);
  const book = buildBook({
    periodDays: period.days,
    promoted: promoted.id,
    assumptions: ASSUMPTIONS,
    setups: review.setups.map((s) => ({
      id: s.setup_id,
      label: s.label,
      costUsd: s.spend_usd,
      sessions: s.sessions,
      survivingChanges: s.surviving_changes ?? 0,
      unattendedShare: s.unattended ?? 0,
    })),
  });
  const notes = review.setups
    .filter((s) => s.spend_lower_bound)
    .map((s) => `${s.setup_id}: spend is a lower bound (some sessions could not be fully priced)`);
  if (promoted.note) notes.push(promoted.note);
  return {
    source: { review: reviewPath, repo: review.repo },
    period,
    promoted,
    ...book,
    assumptionLabels: { ...ASSUMPTION_LABELS },
    notes,
    shareUrl,
    cfo: { written: false, verified: false, error: "not attempted: run with --write" },
  };
}

/** The bit of the file that goes to cfo.ai: exactly buildBook's output, so the readback diff is like for like. */
const bookOnly = (f: BookFile): BookOutput => ({ department: f.department, scenario: f.scenario, assumptions: f.assumptions });

export async function writeToCfo(file: BookFile, client: CfoClient): Promise<CfoOutcome> {
  const r = await writeBook(bookOnly(file), client);
  if (r.ok) return { written: true, verified: true, error: null };
  const err = r.diffs.find((d) => d.path === "$error");
  if (err) return { written: false, verified: false, error: String(err.got) };
  // edit_table_blocks went through but the readback differs.
  const paths = r.diffs.slice(0, 5).map((d) => d.path).join(", ");
  return { written: true, verified: false, error: `readback differs after ${r.attempts} attempts at ${r.diffs.length} paths: ${paths}` };
}

const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));

/**
 * Without --write, an earlier cfo.ai outcome in book.json still holds only if the book it wrote is unchanged.
 * A changed book (or no earlier file) is "not attempted" until the next --write.
 */
export function carriedCfo(previous: unknown, file: BookFile): CfoOutcome | null {
  const prev = previous as Partial<BookFile> | null;
  if (!prev?.cfo || !prev.department || !prev.scenario || !prev.assumptions) return null;
  const same = JSON.stringify(bookOnly(prev as BookFile)) === JSON.stringify(bookOnly(file));
  return same ? prev.cfo : null;
}

export async function main(
  argv: string[],
  opts: { root?: string; out?: string; client?: CfoClient } = {},
): Promise<BookFile> {
  const root = opts.root ?? ROOT;
  const reviewRel = "reports/rajkaria__roster/review.json";
  const review = readJson(join(root, reviewRel)) as Review;
  const sessions = readJson(join(root, "reports/rajkaria__roster/sessions.json")) as Session[];
  const promotionPath = join(root, "reports/self/review-1/promotion.json");
  const promotion = existsSync(promotionPath) ? (readJson(promotionPath) as { promoted?: unknown }) : null;

  const planPath = join(root, "reports/self/cfo-plan.json");
  const shareUrl = existsSync(planPath) ? shareUrlFromPlan(readJson(planPath)) : null;

  const file = bookFromReview(review, sessions, promotion, reviewRel, loadSetups(root, {}), shareUrl);
  const out = opts.out ?? join(root, "reports/self/book.json");
  if (argv.includes("--write")) file.cfo = await writeToCfo(file, opts.client ?? createCfoClient());
  else if (existsSync(out)) file.cfo = carriedCfo(readJson(out), file) ?? file.cfo;

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
  return file;
}

if (import.meta.main) {
  const file = await main(process.argv.slice(2));
  console.log(`wrote reports/self/book.json: ${file.department.length} setups over ${file.period.days.toFixed(2)} days`);
  if (file.cfo.error) console.log(`cfo.ai: ${file.cfo.error}`);
  else console.log("cfo.ai: written and verified");
}
