import { expect, test } from "bun:test";
import { buildCorpusTable } from "../src/review/corpus-table";

const r = (
  repo: string,
  sessions: number,
  costUsd: number | null,
  promoted: string | null = null,
  replayed = 1,
) => ({ repo, sessions, setups: 2, costUsd, suspect: null, replayed, promoted });

test("sorts by sessions desc then repo", () => {
  const t = buildCorpusTable([r("b", 3, 1), r("a", 3, 1), r("c", 9, 1)]);
  expect(t.rows.map((x) => x.repo)).toEqual(["c", "a", "b"]);
});

test("totals equal sums of rows", () => {
  const t = buildCorpusTable([r("a", 3, 1.5, "B"), r("b", 4, null, null, 2), r("c", 5, 2.25, "E")]);
  expect(t.totals.repos).toBe(t.rows.length);
  expect(t.totals.sessions).toBe(t.rows.reduce((s, x) => s + x.sessions, 0));
  expect(t.totals.replayed).toBe(t.rows.reduce((s, x) => s + x.replayed, 0));
  expect(t.totals.costUsd).toBe(3.75);
  expect(t.totals.promotions).toBe(2);
});

test("costUsd null only if every row null; empty input", () => {
  expect(buildCorpusTable([r("a", 1, null)]).totals.costUsd).toBeNull();
  const e = buildCorpusTable([]);
  expect(e.totals).toEqual({ repos: 0, sessions: 0, costUsd: null, replayed: 0, promotions: 0 });
});
