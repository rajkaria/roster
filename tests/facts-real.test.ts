import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FACT_SPECS, renderFacts, writeFacts } from "../scripts/facts";

const setup = (sessions: number, mature: number, spend: number, lower = false) => ({
  setup_id: `s${sessions}`,
  sessions,
  mature_sessions: mature,
  spend_usd: spend,
  spend_lower_bound: lower,
});

// Same layout as reports/<owner>__<repo>/review.json, trimmed to the fields facts read.
function fixture(opts: { lower?: boolean; forward?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "facts-real-"));
  const reports = join(root, "reports");
  const put = (rel: string, data: unknown) => {
    const f = join(root, rel);
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, typeof data === "string" ? data : JSON.stringify(data));
  };
  put("reports/rajkaria__roster/review.json", {
    repo: "rajkaria/roster",
    label: "no_suspect",
    odds_ratio: 4.23250743310208,
    p_value: 1,
    setups: [setup(17, 16, 19.0633692), setup(11, 10, 3.8386401, opts.lower), setup(16, 16, 1.005)],
  });
  put("reports/a__one/review.json", { repo: "a/one", setups: [setup(5, 5, 1), setup(3, 2, 1)] });
  put("reports/b__two/review.json", { repo: "b/two", setups: [setup(4, 4, 1)] });
  put("reports/_sample/review.json", { repo: "x/sample", setups: [setup(100, 100, 1)] });
  put("reports/self/review-1/decisions.json", {
    outcome: "promoted",
    promoted: "E",
    spent: { total_usd: 2.345 },
    decisions: [{ candidate: "D" }, { candidate: "E" }],
  });
  if (opts.forward) {
    put("reports/self/forward.json", {
      pairs: { n: 20 },
      mcnemar: { new_only: 6, old_only: 2, p: 0.2891 },
      wording: "not significant",
    });
  }
  put("experiments/FREEZE.txt", `Forward backlog frozen.\n\nforward-backlog.md                     sha256 ${"ab".repeat(32)}\nacceptance tests (40 files, sorted)    sha256 ${"cd".repeat(32)}\n`);
  return reports;
}

const line = (text: string, key: string) => text.split("\n").find((l) => l.startsWith(`${key} = `))!;
const val = (text: string, key: string) => line(text, key).slice(key.length + 3).split("  (source")[0];

describe("facts from real report layout", () => {
  test("SELF_*, CORPUS_*, REVIEW1_* and BACKLOG come from the files; forward is PENDING when missing", () => {
    const t = renderFacts(fixture(), FACT_SPECS, "T");
    expect(val(t, "SELF_SESSIONS")).toBe("44 sessions");
    expect(val(t, "SELF_MATURE")).toBe("42 mature sessions");
    expect(val(t, "SELF_SETUPS")).toBe("3 setups");
    expect(val(t, "SELF_SPEND_USD")).toBe("23.91 USD, rounded to 2 decimals");
    expect(val(t, "SELF_LABEL")).toBe("no_suspect");
    expect(val(t, "SELF_ODDS_RATIO")).toBe("4.23, rounded to 2 decimals");
    expect(val(t, "SELF_P")).toBe("1.000, rounded to 3 decimals");
    expect(val(t, "CORPUS_REPOS")).toBe("2 repos");
    expect(val(t, "CORPUS_SESSIONS")).toBe("12 sessions");
    expect(line(t, "CORPUS_REPOS")).toContain("excluding rajkaria__roster, _sample");
    expect(val(t, "REVIEW1_OUTCOME")).toBe("promoted");
    expect(val(t, "REVIEW1_PROMOTED")).toBe("E");
    expect(val(t, "REVIEW1_REPLAYS")).toBe("2 candidate replays gated");
    expect(val(t, "REVIEW1_SPEND_USD")).toBe("2.35 USD, rounded to 2 decimals");
    expect(val(t, "BACKLOG_SHA256")).toBe("ab".repeat(32));
    for (const k of ["FORWARD_PAIRS_N", "FORWARD_NEW_ONLY", "FORWARD_OLD_ONLY", "FORWARD_P", "FORWARD_WORDING"]) {
      expect(val(t, k)).toBe("PENDING");
    }
    expect(line(t, "SELF_SESSIONS")).toContain("source: reports/rajkaria__roster/review.json#$.setups[*].sessions");
  });

  test("a lower-bound setup prefixes the spend with ≥", () => {
    const t = renderFacts(fixture({ lower: true }), FACT_SPECS, "T");
    expect(val(t, "SELF_SPEND_USD")).toBe("≥23.91 USD, rounded to 2 decimals");
  });

  test("forward.json fills the FORWARD_* facts", () => {
    const t = renderFacts(fixture({ forward: true }), FACT_SPECS, "T");
    expect(val(t, "FORWARD_PAIRS_N")).toBe("20 pairs");
    expect(val(t, "FORWARD_NEW_ONLY")).toBe("6 pairs");
    expect(val(t, "FORWARD_OLD_ONLY")).toBe("2 pairs");
    expect(val(t, "FORWARD_P")).toBe("0.289, rounded to 3 decimals");
    expect(val(t, "FORWARD_WORDING")).toBe("not significant");
  });

  test("a null promoted prints none; an empty reports dir is all PENDING", () => {
    const reports = fixture();
    writeFileSync(join(reports, "self/review-1/decisions.json"), JSON.stringify({ outcome: "no_better_setup", promoted: null, decisions: [] }));
    const t = renderFacts(reports, FACT_SPECS, "T");
    expect(val(t, "REVIEW1_PROMOTED")).toBe("none");
    const empty = renderFacts(join(mkdtempSync(join(tmpdir(), "facts-empty-")), "reports"), FACT_SPECS, "T");
    expect(empty).not.toMatch(/ = (?!PENDING)/);
  });

  test("a corpus file missing the summed path makes the total PENDING, not smaller", () => {
    const reports = fixture();
    writeFileSync(join(reports, "b__two/review.json"), JSON.stringify({ repo: "b/two" }));
    expect(val(renderFacts(reports, FACT_SPECS, "T"), "CORPUS_SESSIONS")).toBe("PENDING");
  });

  test("a repo review with no setups adds zero sessions", () => {
    const reports = fixture();
    writeFileSync(join(reports, "b__two/review.json"), JSON.stringify({ repo: "b/two", setups: [] }));
    expect(val(renderFacts(reports, FACT_SPECS, "T"), "CORPUS_SESSIONS")).toBe("8 sessions");
  });

  test("writeFacts writes the file", () => {
    const reports = fixture();
    const out = join(reports, "..", "FACTS.md");
    writeFacts(reports, out, FACT_SPECS, "T");
    expect(readFileSync(out, "utf8")).toContain("SELF_SESSIONS = 44 sessions");
  });
});
