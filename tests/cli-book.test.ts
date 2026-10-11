import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ENGINEER_USD,
  DEFAULT_PERIOD_DAYS,
  DEFAULT_SCALE_SESSIONS,
  bookFromReview,
  parseBookArgs,
  periodDays,
  promotedSetup,
  runBookCommand,
  type BookDeps,
} from "../src/cli/book.ts";

const review = {
  id: "rev_123",
  repo: "owner/repo",
  created_at: "2020-01-02T03:04:05.000Z",
  generated_at: "2020-02-03T04:05:06.000Z",
  has_entire_data: true,
  setups: [
    {
      setup_id: "old",
      label: "Old",
      harness: "claude-code",
      model: "m1",
      rules_hash: null,
      sessions: 10,
      mature_sessions: 10,
      spend_usd: 100,
      unattended: 0.5,
      survival: 0.2,
      reverted: 0.3,
      rework_human: 0.2,
      surviving_changes: 2,
      cost_per_surviving_change: 50,
      evidence_level: "A",
    },
    {
      setup_id: "new",
      label: "New",
      harness: "codex",
      model: "m2",
      rules_hash: null,
      sessions: 8,
      mature_sessions: 8,
      spend_usd: 40,
      unattended: 0.75,
      survival: 0.8,
      reverted: 0.05,
      rework_human: 0.05,
      surviving_changes: 6,
      cost_per_surviving_change: 6.667,
      evidence_level: "A",
    },
  ],
  label: "suspect",
  suspect: "old",
  odds_ratio: 3,
  ci95: [1, 9],
  p_value: 0.01,
  evidence_level: "A",
};

/** Collects stdout and records which review path and which book the deps saw. */
function recorder(book: unknown = review, writeResult: { ok: boolean } = { ok: true }) {
  const state = { stdout: "", readPath: "", written: undefined as unknown };
  const deps: BookDeps = {
    readJson: async (path: string) => {
      state.readPath = path;
      return book;
    },
    writeBook: async (b: unknown) => {
      state.written = b;
      return writeResult;
    },
    stdout: (s: string) => {
      state.stdout += s;
    },
  };
  return { state, deps };
}

describe("parseBookArgs", () => {
  test("applies the documented defaults", () => {
    expect(parseBookArgs(["--review", "review.json"])).toEqual({
      review: "review.json",
      engineerUsd: DEFAULT_ENGINEER_USD,
      scaleSessions: DEFAULT_SCALE_SESSIONS,
      write: false,
    });
  });

  test("accepts inline values and the write flag", () => {
    expect(parseBookArgs(["--review=review.json", "--engineer-usd=1000", "--scale-sessions=7", "--write"])).toEqual({
      review: "review.json",
      engineerUsd: 1000,
      scaleSessions: 7,
      write: true,
    });
  });

  test("rejects missing --review, unknown flags and non-numeric values", () => {
    expect(() => parseBookArgs([])).toThrow("missing --review");
    expect(() => parseBookArgs(["--review", "r.json", "--wat"])).toThrow("unknown flag");
    expect(() => parseBookArgs(["--review", "r.json", "--engineer-usd", "lots"])).toThrow("number");
    expect(() => parseBookArgs(["--review", "r.json", "--scale-sessions", "-1"])).toThrow("number");
    expect(() => parseBookArgs(["--review", "r.json", "extra"])).toThrow("unexpected argument");
  });
});

describe("bookFromReview", () => {
  test("scales to a month using the review's date range and picks the best non-suspect setup", () => {
    const book = bookFromReview(review, { engineerUsd: 15000, scaleSessions: 70 });
    expect(book.period).toEqual({
      from: review.created_at,
      to: review.generated_at,
      days: (Date.parse(review.generated_at) - Date.parse(review.created_at)) / 86_400_000,
    });
    // "old" is the suspect, so the scenario scales "new" (8 sessions, $40 => $5/session).
    const sessionsPerMonth = 70 * (30 / 7);
    expect(book.scenario.hireMonthlyUsd).toBe(15000);
    expect(book.scenario.scaleMonthlyUsd).toBeCloseTo(5 * sessionsPerMonth, 6);
    expect(book.department.map((d) => d.setup)).toEqual(["old", "new"]);
    expect(book.assumptions).toEqual({ engineerMonthlyLoadedUsd: 15000, scaleSessionsPerWeek: 70 });
  });

  test("falls back to a 30-day period when the review has no dates", () => {
    const { created_at: _c, generated_at: _g, ...undated } = review;
    const book = bookFromReview(undated, { engineerUsd: 15000, scaleSessions: 50 });
    expect(book.period).toEqual({ from: null, to: null, days: DEFAULT_PERIOD_DAYS });
    expect(book.department[0]?.monthlySpendUsd).toBe(100);
  });

  test("rejects anything that is not a review-shaped object", () => {
    expect(() => bookFromReview(null, { engineerUsd: 1, scaleSessions: 1 })).toThrow("not an object");
    expect(() => bookFromReview({ setups: "no" }, { engineerUsd: 1, scaleSessions: 1 })).toThrow("setups array");
  });
});

describe("promotedSetup", () => {
  test("prefers the highest survival among non-suspect setups", () => {
    expect(promotedSetup(review.setups, "old")).toBe("new");
  });

  test("breaks survival ties on lower cost per surviving change, then id", () => {
    const setups = [
      { setup_id: "b", survival: 0.5, cost_per_surviving_change: 10 },
      { setup_id: "a", survival: 0.5, cost_per_surviving_change: 10 },
      { setup_id: "c", survival: 0.5, cost_per_surviving_change: 5 },
    ];
    expect(promotedSetup(setups, null)).toBe("c");
    expect(promotedSetup(setups.slice(0, 2), null)).toBe("a");
  });

  test("is null when no setup has a scored survival", () => {
    expect(promotedSetup([{ setup_id: "x", survival: null }], null)).toBeNull();
    expect(promotedSetup([], null)).toBeNull();
  });
});

describe("periodDays", () => {
  test("uses the range, and the default for unusable input", () => {
    expect(periodDays("2020-01-01T00:00:00Z", "2020-01-11T00:00:00Z")).toBe(10);
    expect(periodDays(null, "2020-01-11T00:00:00Z")).toBe(DEFAULT_PERIOD_DAYS);
    expect(periodDays("not-a-date", "2020-01-11T00:00:00Z")).toBe(DEFAULT_PERIOD_DAYS);
    expect(periodDays("2020-01-11T00:00:00Z", "2020-01-11T00:00:00Z")).toBe(DEFAULT_PERIOD_DAYS);
  });
});

describe("runBookCommand", () => {
  test("missing --review prints usage and returns 2", async () => {
    const { state, deps } = recorder();
    expect(await runBookCommand([], deps)).toBe(2);
    expect(state.stdout).toMatch(/usage/i);
  });

  test("without --write prints the book JSON using the defaults", async () => {
    const { state, deps } = recorder();
    expect(await runBookCommand(["--review", "review.json"], deps)).toBe(0);
    expect(state.readPath).toBe("review.json");
    expect(state.stdout).toContain(String(DEFAULT_ENGINEER_USD));
    expect(state.stdout).toContain(String(DEFAULT_SCALE_SESSIONS));
    expect(state.stdout).toContain(review.created_at);
    expect(state.stdout).toContain(review.generated_at);
    const printed = JSON.parse(state.stdout) as { period: { from: string }; scenario: { hireMonthlyUsd: number } };
    expect(printed.period.from).toBe(review.created_at);
    expect(printed.scenario.hireMonthlyUsd).toBe(DEFAULT_ENGINEER_USD);
  });

  test("honours --engineer-usd and --scale-sessions", async () => {
    const { state, deps } = recorder();
    expect(await runBookCommand(["--review", "review.json", "--engineer-usd", "123456", "--scale-sessions", "777"], deps)).toBe(0);
    expect(state.stdout).toContain("123456");
    expect(state.stdout).toContain("777");
  });

  test("--write calls deps.writeBook, prints nothing, and returns 0 on ok", async () => {
    const { state, deps } = recorder();
    expect(await runBookCommand(["--review", "review.json", "--write"], deps)).toBe(0);
    expect(state.written).toBeDefined();
    expect(state.stdout).toBe("");
  });

  test("--write returns 1 when cfo.ai refuses the book", async () => {
    const { state, deps } = recorder(review, { ok: false });
    expect(await runBookCommand(["--review", "review.json", "--write"], deps)).toBe(1);
    expect(state.stdout).not.toBe("");
  });

  test("returns 1 when the review cannot be read or built", async () => {
    const { deps } = recorder({ not: "a review" });
    expect(await runBookCommand(["--review", "bad.json"], deps)).toBe(1);
  });
});
