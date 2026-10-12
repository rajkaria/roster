// F16: the /book page's data helper formats the AI-workforce department and the hire-vs-scale scenario.
// The fixture book is derived from the real published review (reports/rajkaria__roster/review.json); the
// only literal numbers here are formatting cases, the same ones the task text names.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Review } from "../web/lib/types.ts";
import { bookPath, emptyBook, loadBook, loadBookFromData, money, percent } from "../web/lib/book.ts";

const ROOT = join(import.meta.dir, "..");
const REAL = join(ROOT, "reports", "rajkaria__roster", "review.json");
const review: Review = JSON.parse(readFileSync(REAL, "utf8"));
const first = review.setups[0]!;
const second = review.setups[1]!;

/** The department and scenario as src/cfo/book.ts writes them, from the real review's own numbers. */
const realBook = {
  periodDays: 7,
  department: review.setups.map((s) => ({
    setup: s.setup_id,
    label: s.label,
    monthlySpendUsd: s.spend_usd,
    survivingChangesPerMonth: s.surviving_changes,
    costPerSurvivingChangeUsd: s.cost_per_surviving_change,
    unattendedPct: s.unattended === null ? null : s.unattended * 100,
  })),
  scenario: { hireMonthlyUsd: first.spend_usd, scaleMonthlyUsd: second.cost_per_surviving_change },
  shareUrl: "https://cfo.ai/reports/rajkaria-roster",
};

describe("money", () => {
  test("two decimals with thousands separators", () => {
    expect(money(1234.56)).toBe("$1,234.56");
    expect(money(0.42)).toBe("$0.42");
    expect(money(19.0633692)).toBe("$19.06");
  });

  test("null and non-numbers read n/a", () => {
    for (const v of [null, undefined, "12", Number.NaN, Number.POSITIVE_INFINITY, true]) {
      expect(money(v)).toBe("n/a");
    }
  });
});

describe("percent", () => {
  test("a share becomes a percent with one decimal", () => {
    expect(percent(0.42)).toBe("42.0%");
    expect(percent(0)).toBe("0.0%");
    expect(percent(1)).toBe("100.0%");
  });

  test("a value above one is already a percent", () => {
    expect(percent(12.5)).toBe("12.5%");
    expect(percent(100)).toBe("100.0%");
  });

  test("null and non-numbers read n/a", () => {
    for (const v of [null, undefined, "42%", Number.NaN]) expect(percent(v)).toBe("n/a");
  });
});

describe("loadBook", () => {
  test("formats the department the publisher writes, one row per setup, in order", () => {
    const book = loadBook(realBook);
    expect(book.rows.length).toBe(review.setups.length);
    book.rows.forEach((row, i) => {
      const s = review.setups[i]!;
      expect(row.setup).toBe(s.setup_id);
      expect(row.label).toBe(s.label);
      expect(row.monthly).toBe(money(s.spend_usd));
      expect(row.perChange).toBe(money(s.cost_per_surviving_change));
      expect(row.unattended).toBe(percent(s.unattended === null ? null : s.unattended * 100));
    });
    expect(book.scenario).toEqual({
      hire: money(first.spend_usd),
      scale: money(second.cost_per_surviving_change),
    });
    expect(book.shareUrl).toBe("https://cfo.ai/reports/rajkaria-roster");
  });

  test("reads a page-shaped book: rows key, setup_id fallback, perChange as a share", () => {
    const rows = [
      { setup: first.setup_id, label: first.label, monthly: first.spend_usd, perChange: first.unattended, unattended: true },
      { setup_id: second.setup_id, monthly: null, perChange: null, unattended: false },
    ];
    const book = loadBook({ rows, scenario: { hire: first.spend_usd, scale: null } });
    expect(book.rows[0]!.monthly).toBe(money(first.spend_usd));
    expect(book.rows[0]!.perChange).toBe(percent(first.unattended));
    expect(book.rows[0]!.unattended).toBe("yes");
    // A row with no setup name falls back to its id, and no label falls back to that name.
    expect(book.rows[1]!.setup).toBe(second.setup_id);
    expect(book.rows[1]!.label).toBe(second.setup_id);
    expect(book.rows[1]!.monthly).toBe("n/a");
    expect(book.rows[1]!.perChange).toBe("n/a");
    expect(book.rows[1]!.unattended).toBe("no");
    expect(book.scenario).toEqual({ hire: money(first.spend_usd), scale: "n/a" });
  });

  test("null, absent and malformed inputs give the empty state", () => {
    for (const v of [null, undefined, "book", 42, [], true]) {
      expect(loadBook(v)).toEqual({ rows: [], scenario: null, shareUrl: null });
    }
    expect(loadBook({})).toEqual({ rows: [], scenario: null, shareUrl: null });
    expect(emptyBook()).toEqual({ rows: [], scenario: null, shareUrl: null });
  });

  test("keeps shareUrl only for an https URL on cfo.ai", () => {
    const base = { rows: [], department: [] };
    expect(loadBook({ ...base, shareUrl: "https://cfo.ai/reports/1" }).shareUrl).toBe("https://cfo.ai/reports/1");
    expect(loadBook({ ...base, shareUrl: "https://app.cfo.ai/reports/1" }).shareUrl).toBe("https://app.cfo.ai/reports/1");
    for (const bad of [
      "http://cfo.ai/reports/1",
      "https://example.com/reports/1",
      "https://cfo.ai.evil.example/reports/1",
      "https://notcfo.ai/reports/1",
      "not a url",
      "",
      null,
      first.spend_usd,
    ]) {
      expect(loadBook({ ...base, shareUrl: bad }).shareUrl).toBeNull();
    }
  });
});

describe("loadBookFromData", () => {
  test("absent self/book.json is the empty state", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-book-"));
    try {
      expect(loadBookFromData(dir)).toEqual({ rows: [], scenario: null, shareUrl: null });
      mkdirSync(join(dir, "self"));
      expect(loadBookFromData(dir)).toEqual({ rows: [], scenario: null, shareUrl: null });
      writeFileSync(bookPath(dir), "{not json");
      expect(loadBookFromData(dir)).toEqual({ rows: [], scenario: null, shareUrl: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads public/data/self/book.json only, and formats it", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-book-"));
    try {
      mkdirSync(join(dir, "self"), { recursive: true });
      // A book somewhere else in the data dir is not the book.
      writeFileSync(join(dir, "book.json"), JSON.stringify({ ...realBook, department: [] }));
      writeFileSync(bookPath(dir), JSON.stringify(realBook));
      const book = loadBookFromData(dir);
      expect(book.rows.length).toBe(review.setups.length);
      expect(book.rows[0]!.setup).toBe(first.setup_id);
      expect(book.scenario!.hire).toBe(money(first.spend_usd));
      expect(book.shareUrl).toBe("https://cfo.ai/reports/rajkaria-roster");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("page source", () => {
  const SRC = readFileSync(join(ROOT, "web", "app", "book", "page.tsx"), "utf8");

  test("no number literals and no em dashes in the book page", () => {
    expect(SRC.match(/\b\d+(\.\d+)?\b/g)).toBeNull();
    expect(SRC).not.toContain("—");
  });

  test("the cfo.ai link is rendered only behind a shareUrl", () => {
    expect(SRC).toContain("View in cfo.ai");
    expect(SRC).toMatch(/book\.shareUrl\s*&&/);
  });
});

describe("bookContext", () => {
  test("reads the period and the assumed sessions a week from book.json, and nulls when absent", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { bookContext } = await import("../web/lib/book.ts");
    const dir = mkdtempSync(join(tmpdir(), "book-ctx-"));
    expect(bookContext(dir)).toEqual({ periodDays: null, sessionsPerWeek: null });
    mkdirSync(join(dir, "self"));
    writeFileSync(join(dir, "self", "book.json"), JSON.stringify({ period: { days: 1.4231 }, assumptions: { scaleSessionsPerWeek: 50 } }));
    expect(bookContext(dir)).toEqual({ periodDays: "1.42", sessionsPerWeek: 50 });
  });
});
