import { describe, expect, test } from "bun:test";
import { nightlyComment, type NightlyRow } from "../src/cli/nightly.ts";

const OPTS = { repo: "owner/repo", date: "2025-01-02", threshold: 5 };

function row(overrides: Partial<NightlyRow> = {}): NightlyRow {
  return { setup: "alpha", field: "field", before: 1, after: 2, delta: 1, ...overrides };
}

describe("nightlyComment", () => {
  test("heads the comment with the repo and the date", () => {
    expect(nightlyComment([], OPTS).split("\n")[0]).toBe("# Roster nightly review: owner/repo, 2025-01-02");
  });

  test("says nothing changed when every row is below the threshold", () => {
    const out = nightlyComment(
      [row({ field: "small", delta: 4 }), row({ field: "tiny", delta: -0.5 }), row({ field: "null", delta: null })],
      OPTS,
    );
    expect(out).toContain("No changes above 5.");
    expect(out).not.toContain("small");
    expect(out).not.toContain("tiny");
  });

  test("keeps rows at or above the threshold in absolute value and drops the rest", () => {
    const out = nightlyComment(
      [
        row({ field: "at", delta: 5 }),
        row({ field: "above", delta: 6 }),
        row({ field: "below", delta: 4 }),
        row({ field: "at-negative", delta: -5 }),
        row({ field: "null-delta", delta: null }),
      ],
      OPTS,
    );
    for (const f of ["at", "above", "at-negative"]) expect(out).toContain(f);
    expect(out).not.toContain("below");
    expect(out).not.toContain("null-delta");
  });

  test("lists a zero delta only when the threshold is zero", () => {
    const zero = row({ field: "zero", before: 5, after: 5, delta: 0 });
    expect(nightlyComment([zero], OPTS)).toContain("No changes above 5.");
    expect(nightlyComment([zero], { ...OPTS, threshold: 0 })).toContain("zero");
  });

  test("marks a rise with ▲ and a fall with ▼ on the row's own line", () => {
    const out = nightlyComment([row({ field: "up", delta: 5 }), row({ field: "down", delta: -7 })], OPTS);
    const line = (f: string) => out.split("\n").find((l) => l.includes(f))!;
    expect(line("up")).toContain("▲");
    expect(line("down")).toContain("▼");
    expect(out.indexOf("up")).toBeLessThan(out.indexOf("down"));
  });

  test("renders the move as before → after and the signed delta", () => {
    const out = nightlyComment([row({ field: "score", before: 10, after: 13, delta: 3 })], { ...OPTS, threshold: 3 });
    expect(out).toContain("score: 10 → 13 ▲ 3");
  });

  test("renders a missing side as — rather than as a number", () => {
    const out = nightlyComment([row({ field: "new-field", before: null, after: 12, delta: 12 })], OPTS);
    expect(out).toContain("new-field: — → 12 ▲ 12");
  });

  test("groups the rows of a setup together, even when the input interleaves them", () => {
    const out = nightlyComment(
      [
        row({ setup: "alpha", field: "alpha-one", delta: 5 }),
        row({ setup: "beta", field: "beta-one", delta: 6 }),
        row({ setup: "alpha", field: "alpha-two", delta: 7 }),
      ],
      OPTS,
    );
    expect(out).toContain("## alpha");
    expect(out).toContain("## beta");
    const one = out.indexOf("alpha-one");
    const two = out.indexOf("alpha-two");
    expect(out.indexOf("beta-one") < one || out.indexOf("beta-one") > two).toBe(true);
    // First-seen order: alpha was seen first.
    expect(out.indexOf("## alpha")).toBeLessThan(out.indexOf("## beta"));
  });

  test("lists at most 20 rows and counts the rest in one +N more line", () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      row({ field: `row-${String(i + 1).padStart(2, "0")}`, delta: 5 + i }),
    );
    const out = nightlyComment(rows, OPTS);
    expect(out).toContain("+5 more");
    for (let i = 1; i <= 20; i++) expect(out).toContain(`row-${String(i).padStart(2, "0")}`);
    for (let i = 21; i <= 25; i++) expect(out).not.toContain(`row-${String(i).padStart(2, "0")}`);
  });

  test("caps across setup groups and still reports the rows it held back", () => {
    const rows = [
      ...Array.from({ length: 15 }, (_, i) => row({ setup: "alpha", field: `a-${i}`, delta: 9 })),
      ...Array.from({ length: 10 }, (_, i) => row({ setup: "beta", field: `b-${i}`, delta: 9 })),
    ];
    const out = nightlyComment(rows, OPTS);
    expect(out).toContain("+5 more");
    expect(out).toContain("a-14");
    expect(out).toContain("b-4");
    expect(out).not.toContain("b-5");
  });

  test("lists nothing above the threshold when the row list is empty", () => {
    expect(nightlyComment([], OPTS)).toBe(
      ["# Roster nightly review: owner/repo, 2025-01-02", "", "No changes above 5."].join("\n"),
    );
  });

  test("does not mutate the rows it is given", () => {
    const rows = [row({ delta: 9 })];
    const copy = structuredClone(rows);
    nightlyComment(rows, OPTS);
    expect(rows).toEqual(copy);
  });
});
