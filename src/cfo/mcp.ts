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

export async function writeBook(
  book: Book,
  client: Client,
  opts: { retries?: number } = {},
): Promise<{ ok: boolean; attempts: number; diffs: Diff[] }> {
  const maxAttempts = 1 + Math.max(0, opts.retries ?? 1);
  let diffs: Diff[] = [];
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts++;
    try {
      await client.call("edit_table_blocks", { book });
      const res = (await client.call("inspect_table_blocks", {})) as { book?: Book } | null | undefined;
      diffs = diffBook(book, (res?.book ?? {}) as Book);
      if (diffs.length === 0) return { ok: true, attempts, diffs };
    } catch (e) {
      diffs = [{ path: "$error", sent: undefined, got: e instanceof Error ? e.message : String(e) }];
    }
  }
  return { ok: false, attempts, diffs };
}
