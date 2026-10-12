import type { buildBook } from "./book";

type Book = ReturnType<typeof buildBook>;
type Diff = { path: string; sent: unknown; got: unknown };
type Client = { call(tool: string, args: Record<string, unknown>): Promise<unknown> };

const TOLERANCE = 0.005;

function flatten(v: unknown, path: string, out: Map<string, unknown>): void {
  if (Array.isArray(v)) {
    if (v.length === 0) out.set(path, v);
    v.forEach((x, i) => flatten(x, `${path}[${i}]`, out));
  } else if (v !== null && typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length === 0) out.set(path, v);
    for (const k of keys) flatten((v as Record<string, unknown>)[k], path ? `${path}.${k}` : k, out);
  } else {
    out.set(path, v);
  }
}

function same(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= TOLERANCE;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === 0 && b.length === 0;
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    return Object.keys(a).length === 0 && Object.keys(b).length === 0;
  }
  return a === b;
}

export function diffBook(sent: Book, readback: Book): Diff[] {
  const s = new Map<string, unknown>();
  const g = new Map<string, unknown>();
  flatten(sent, "", s);
  flatten(readback ?? {}, "", g);
  const paths = [...s.keys(), ...[...g.keys()].filter((p) => !s.has(p))];
  const diffs: Diff[] = [];
  for (const path of paths) {
    const a = s.get(path);
    const b = g.get(path);
    if (!s.has(path) || !g.has(path) || !same(a, b)) diffs.push({ path, sent: a, got: b });
  }
  return diffs;
}

/**
 * The cfo.ai table the department lives in: "AI workforce department" on the page "Roster: AI workforce book", one row
 * per setup (dimension "Book setup", members are setup ids), columns in this order. Shapes are cfo.ai's
 * edit_table_blocks `update` and inspect_table_blocks `read`, as the live server answered them on 2026-10-12.
 */
export const BOOK_TABLE = "AI workforce department";
export const BOOK_SCENARIO = "Main Scenario";
export const BOOK_DIMENSION = "Book setup";
export const BOOK_COLUMNS = [
  "Setup label",
  "Monthly spend (USD, MEASURED)",
  "Surviving changes per month (MEASURED)",
  "Cost per surviving change (USD, MEASURED)",
  "Unattended % (MEASURED)",
] as const;

type DepartmentRow = Book["department"][number];
const rowCells = (d: DepartmentRow): unknown[] => [
  d.label,
  d.monthlySpendUsd,
  d.survivingChangesPerMonth,
  d.costPerSurvivingChangeUsd,
  d.unattendedPct,
];

/** edit_table_blocks arguments that overwrite the department rows with this book's numbers. */
export function bookUpdateArgs(book: Book): Record<string, unknown> {
  return {
    update: {
      target: BOOK_TABLE,
      scenario: BOOK_SCENARIO,
      values: {
        columns: [...BOOK_COLUMNS],
        rows: book.department.map((d) => [`${BOOK_DIMENSION}[${d.setup}]`, ...rowCells(d)]),
      },
    },
  };
}

/** inspect_table_blocks arguments that read the department table back. */
export const bookReadArgs = (): Record<string, unknown> => ({ read: { target: BOOK_TABLE, scenario: BOOK_SCENARIO, depth: "all" } });

type TableRead = {
  columns?: { display_name?: string }[];
  rows?: { member?: string; values?: unknown[] }[];
};

/** A read cell is { value, formula, style }; the bridge's model sometimes echoes it as the bare value, so take either. */
const cellValue = (cell: unknown): unknown =>
  cell !== null && typeof cell === "object" ? ((cell as { value?: unknown }).value ?? null) : (cell ?? null);

/** The department rows in an inspect_table_blocks read, in `order` (setup ids); null when it is not that table. */
export function parseBookTable(res: unknown, order: string[]): Pick<Book, "department"> | null {
  const t = res as TableRead | null | undefined;
  if (!t || !Array.isArray(t.columns) || !Array.isArray(t.rows)) return null;
  const at = BOOK_COLUMNS.map((c) => t.columns!.findIndex((col) => col.display_name === c));
  if (at.some((i) => i < 0)) return null;
  const byMember = new Map<string, DepartmentRow>();
  for (const r of t.rows) {
    if (typeof r.member !== "string" || !Array.isArray(r.values)) continue;
    const v = at.map((i) => cellValue(r.values![i]));
    byMember.set(r.member, {
      setup: r.member,
      label: v[0] as string,
      monthlySpendUsd: v[1] as number | null,
      survivingChangesPerMonth: v[2] as number,
      costPerSurvivingChangeUsd: v[3] as number | null,
      unattendedPct: v[4] as number,
    });
  }
  const department = order.map((id) => byMember.get(id)).filter((r): r is DepartmentRow => r !== undefined);
  return { department };
}

/**
 * Writes the book's department rows into cfo.ai and reads them back, retrying once on a mismatch. ok means every
 * row and number came back as sent (numbers within 0.005).
 */
export async function writeBook(
  book: Book,
  client: Client,
  opts: { retries?: number } = {},
): Promise<{ ok: boolean; attempts: number; diffs: Diff[] }> {
  const maxAttempts = 1 + Math.max(0, opts.retries ?? 1);
  const sent = { department: book.department };
  const order = book.department.map((d) => d.setup);
  let diffs: Diff[] = [];
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts++;
    try {
      await client.call("edit_table_blocks", bookUpdateArgs(book));
      const got = parseBookTable(await client.call("inspect_table_blocks", bookReadArgs()), order);
      diffs = diffBook(sent as Book, (got ?? {}) as Book);
      if (diffs.length === 0) return { ok: true, attempts, diffs };
    } catch (e) {
      diffs = [{ path: "$error", sent: undefined, got: e instanceof Error ? e.message : String(e) }];
    }
  }
  return { ok: false, attempts, diffs };
}
