// `roster nightly`: the comment Roster posts after each nightly review, saying what changed since the last one.
// The rows are the output of the review diff (one row per setup and metric); this module only renders them, so
// nightlyComment is pure over its arguments and can be tested without a database.

/** One changed metric: a setup's `field` moved from `before` to `after` by `delta` (null when a side is missing). */
export interface NightlyRow {
  setup: string;
  field: string;
  before: number | null;
  after: number | null;
  delta: number | null;
}

export interface NightlyOptions {
  repo: string;
  /** The review's date, as Roster writes it (e.g. "2025-01-02"). */
  date: string;
  /** A row is listed only when |delta| is at least this. */
  threshold: number;
}

/** At most this many rows are listed; the rest are counted in a single "+N more" line. */
const MAX_ROWS = 20;

/** A delta is a change worth listing only when it is a number at or above the threshold in absolute value. */
function qualifies(delta: number | null, threshold: number): boolean {
  return delta !== null && Number.isFinite(delta) && Math.abs(delta) >= threshold;
}

/** Trims float noise (0.30000000000000004) without turning 5 into "5.0000". */
function num(n: number | null): string {
  return n === null || !Number.isFinite(n) ? "—" : String(Number(n.toFixed(4)));
}

/** ▲ for a rise. A zero delta is only listed at threshold 0, and it is not a fall, so it takes ▲ too. */
function arrow(delta: number): string {
  return delta < 0 ? "▼" : "▲";
}

/**
 * The Markdown comment for one night's review of `repo`: every metric whose change since the last review is at
 * least `threshold` in absolute value, grouped under its setup, each line "field: before → after ▲/▼ delta".
 * Setups appear in the order their first listed row does, so a setup is never split. At most MAX_ROWS rows are
 * listed, followed by "+N more" when rows were held back. With nothing to list, the comment says so.
 */
export function nightlyComment(rows: NightlyRow[], opts: NightlyOptions): string {
  const lines = [`# Roster nightly review: ${opts.repo}, ${opts.date}`, ""];

  const listed = rows.filter((r) => qualifies(r.delta, opts.threshold));
  if (listed.length === 0) {
    lines.push(`No changes above ${opts.threshold}.`);
    return lines.join("\n");
  }

  // Group by setup, keeping first-seen order for the groups and input order inside each one.
  const groups = new Map<string, NightlyRow[]>();
  for (const row of listed) {
    const group = groups.get(row.setup);
    if (group) group.push(row);
    else groups.set(row.setup, [row]);
  }

  let shown = 0;
  let held = 0;
  for (const [setup, group] of groups) {
    const room = MAX_ROWS - shown;
    if (room <= 0) {
      held += group.length;
      continue;
    }
    const take = group.slice(0, room);
    held += group.length - take.length;
    shown += take.length;
    lines.push(`## ${setup}`, "");
    for (const row of take) {
      lines.push(`- ${row.field}: ${num(row.before)} → ${num(row.after)} ${arrow(row.delta!)} ${num(row.delta)}`);
    }
    lines.push("");
  }

  if (held > 0) lines.push(`+${held} more`);
  return lines.join("\n").trimEnd();
}
