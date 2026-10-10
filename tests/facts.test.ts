import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderFacts, writeFacts } from "../scripts/facts";
import { formatDiff, sumcheck } from "../scripts/sumcheck";

const good = {
  sessions: { total: 10, by_setup: { a: 6, b: 4 } },
  pairs: { n: 5, pass: 3, fail: 1, excluded: 1, pass_pct: 60 },
  cost_total_usd: 3.5,
  cost_by_setup: { a: 2, b: 1.5 },
};

function dirWith(report: unknown): string {
  const d = mkdtempSync(join(tmpdir(), "reports-"));
  mkdirSync(join(d, "sub"));
  writeFileSync(join(d, "sub", "r.json"), JSON.stringify(report));
  return d;
}

test("good report passes sumcheck", () => {
  const r = sumcheck(dirWith(good));
  expect(r.files).toBe(1);
  expect(r.mismatches).toEqual([]);
});

test("wrong total fails sumcheck with a readable diff", () => {
  const bad = { ...good, sessions: { total: 11, by_setup: { a: 6, b: 4 } } };
  const r = sumcheck(dirWith(bad));
  expect(r.mismatches.length).toBe(1);
  expect(formatDiff(r.mismatches)).toContain("- expected: 10\n+ actual:   11");
});

test("pass+fail+excluded, cost and percentage mismatches are caught", () => {
  const bad = {
    pairs: { n: 5, pass: 3, fail: 1, excluded: 0, pass_pct: 70 },
    cost_total_usd: 9,
    cost_by_setup: { a: 2, b: 1.5 },
  };
  expect(sumcheck(dirWith(bad)).mismatches.length).toBe(3);
});

test("facts: missing source prints PENDING, present source prints value", () => {
  const d = dirWith(good);
  writeFileSync(join(d, "review.json"), JSON.stringify(good));
  const specs = [
    { key: "SESSIONS_TOTAL", file: "review.json", path: "$.sessions.total" },
    { key: "NOPE", file: "missing.json", path: "$.x" },
    { key: "BADPATH", file: "review.json", path: "$.sessions.zzz" },
  ];
  const text = renderFacts(d, specs, "T");
  expect(text).toContain("SESSIONS_TOTAL = 10  (source: reports/review.json#$.sessions.total, generated T)");
  expect(text).toContain("NOPE = PENDING");
  expect(text).toContain("BADPATH = PENDING");
});

test("writeFacts writes the file", () => {
  const d = dirWith(good);
  const out = join(d, "FACTS.md");
  writeFacts(d, out, [{ key: "K", file: "none.json", path: "$.a" }], "T");
  expect(readFileSync(out, "utf8")).toContain("K = PENDING");
});
