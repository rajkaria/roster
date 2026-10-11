// `roster book --review <path>`: build the AI-workforce book (department + hire-vs-scale) from a saved
// review and print it, or hand it to cfo.ai with --write (DESIGN.md §"Book (cfo.ai)"). All I/O goes through
// `deps`, so the command is testable without a filesystem or a cfo.ai client; the CLI wiring injects them.
import { buildBook, type BookOutput, type BookSetup } from "../cfo/book.ts";
import { UsageError } from "./review.ts";

export const DEFAULT_ENGINEER_USD = 15_000;
export const DEFAULT_SCALE_SESSIONS = 50;
/** Period used when the review carries no usable date range. A month keeps the book's monthly figures unscaled. */
export const DEFAULT_PERIOD_DAYS = 30;

const USAGE = `usage: roster book --review <path> [--engineer-usd N] [--scale-sessions N] [--write]

  --review <path>     a saved review.json, e.g. reports/<slug>/review.json
  --engineer-usd N    loaded monthly cost of one engineer (default ${DEFAULT_ENGINEER_USD})
  --scale-sessions N  sessions per week if the promoted setup is scaled (default ${DEFAULT_SCALE_SESSIONS})
  --write             write the book to cfo.ai instead of printing it`;

/** Everything the command touches outside its own logic. The CLI supplies the real ones; tests supply fakes. */
export interface BookDeps {
  readJson(path: string): Promise<unknown>;
  writeBook?: (book: unknown) => Promise<{ ok: boolean }>;
  stdout(s: string): void;
}

export interface BookArgs {
  review: string;
  engineerUsd: number;
  scaleSessions: number;
  write: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A finite number, or null for anything else. */
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Parses the arguments after `book`. Throws UsageError on anything it does not accept. */
export function parseBookArgs(args: string[]): BookArgs {
  let review: string | undefined;
  let engineerUsd = DEFAULT_ENGINEER_USD;
  let scaleSessions = DEFAULT_SCALE_SESSIONS;
  let write = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);
    // A flag takes its value inline (--review=path) or as the next argument (--review path).
    const takeValue = (): string => {
      if (eq !== -1) return a.slice(eq + 1);
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${name} needs a value`);
      return v;
    };
    const positive = (): number => {
      const raw = takeValue();
      const n = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(n) || n < 0) throw new UsageError(`${name} needs a number ≥ 0, got "${raw}"`);
      return n;
    };
    if (name === "--write" && eq === -1) write = true;
    else if (name === "--review") review = takeValue();
    else if (name === "--engineer-usd") engineerUsd = positive();
    else if (name === "--scale-sessions") scaleSessions = positive();
    else if (a.startsWith("-")) throw new UsageError(`unknown flag ${a}`);
    else throw new UsageError(`unexpected argument ${a}`);
  }
  if (review === undefined) throw new UsageError("missing --review");
  return { review, engineerUsd, scaleSessions, write };
}

/** The book JSON: the built book plus the review's date range it was scaled from. */
export interface ReviewBook extends BookOutput {
  period: { from: string | null; to: string | null; days: number };
}

/** One review setup as the book builder wants it. A missing unattended share counts as 0, never NaN. */
function toBookSetup(raw: unknown): BookSetup {
  if (!isRecord(raw)) throw new Error("a review setup is not an object");
  const id = str(raw.setup_id);
  if (id === null) throw new Error("a review setup has no setup_id");
  return {
    id,
    label: str(raw.label) ?? id,
    costUsd: num(raw.spend_usd),
    sessions: num(raw.sessions) ?? 0,
    survivingChanges: num(raw.surviving_changes) ?? 0,
    unattendedShare: num(raw.unattended) ?? 0,
  };
}

/**
 * The setup the hire-vs-scale scenario scales: the review's best performer by survival, ignoring the
 * suspect setup (the one flagged as worse). Ties break on the lower cost per surviving change, then the
 * id, so the choice is deterministic. null when no setup has a scored survival.
 */
export function promotedSetup(raws: readonly unknown[], suspect: string | null): string | null {
  let best: { id: string; survival: number; costPer: number } | null = null;
  for (const raw of raws) {
    if (!isRecord(raw)) continue;
    const id = str(raw.setup_id);
    const survival = num(raw.survival);
    if (id === null || survival === null || id === suspect) continue;
    const candidate = { id, survival, costPer: num(raw.cost_per_surviving_change) ?? Number.POSITIVE_INFINITY };
    const better =
      best === null ||
      candidate.survival > best.survival ||
      (candidate.survival === best.survival && candidate.costPer < best.costPer) ||
      (candidate.survival === best.survival && candidate.costPer === best.costPer && candidate.id < best.id);
    if (better) best = candidate;
  }
  return best?.id ?? null;
}

/** Days from the review's date range, or the default when it is missing, unparseable or not forward-going. */
export function periodDays(from: string | null, to: string | null): number {
  if (from === null || to === null) return DEFAULT_PERIOD_DAYS;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return DEFAULT_PERIOD_DAYS;
  const days = (end - start) / 86_400_000;
  return days > 0 ? days : DEFAULT_PERIOD_DAYS;
}

/** Builds the book from a parsed review.json. Throws when the review is not a review-shaped object. */
export function bookFromReview(review: unknown, opts: { engineerUsd: number; scaleSessions: number }): ReviewBook {
  if (!isRecord(review)) throw new Error("the review is not an object");
  const setupsRaw = review.setups;
  if (!Array.isArray(setupsRaw)) throw new Error("the review has no setups array");

  const from = str(review.created_at);
  const to = str(review.generated_at);
  const days = periodDays(from, to);
  const book = buildBook({
    periodDays: days,
    setups: setupsRaw.map(toBookSetup),
    promoted: promotedSetup(setupsRaw, str(review.suspect)),
    assumptions: { engineerMonthlyLoadedUsd: opts.engineerUsd, scaleSessionsPerWeek: opts.scaleSessions },
  });
  return { ...book, period: { from, to, days } };
}

/**
 * Runs `roster book`. Resolves to the exit code: 0 when the book is printed or written, 1 when it could not
 * be built or cfo.ai refused it, 2 for a usage error (the usage line goes to `deps.stdout`).
 */
export async function runBookCommand(args: string[], deps: BookDeps): Promise<number> {
  let parsed: BookArgs;
  try {
    parsed = parseBookArgs(args);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    deps.stdout(`${USAGE}\n`);
    return 2;
  }

  let book: ReviewBook;
  try {
    book = bookFromReview(await deps.readJson(parsed.review), parsed);
  } catch (err) {
    deps.stdout(`roster book: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  if (!parsed.write) {
    deps.stdout(`${JSON.stringify(book, null, 2)}\n`);
    return 0;
  }

  if (deps.writeBook === undefined) {
    deps.stdout("roster book: --write needs a cfo.ai writer, which was not provided\n");
    return 1;
  }
  try {
    const res = await deps.writeBook(book);
    if (!res.ok) {
      deps.stdout("roster book: cfo.ai did not accept the book\n");
      return 1;
    }
    return 0;
  } catch (err) {
    deps.stdout(`roster book: cfo.ai write failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
