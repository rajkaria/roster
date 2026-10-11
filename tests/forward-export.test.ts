// T72: exporting the forward run for /experiment and FACTS. The fixture database is written by ForwardStore, the
// harness's own writer, so it has the real schema; the exclusion is the real F11 entry from
// reports/self/forward-exclusions.json, and the hashes come from the real experiments/FREEZE.txt.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildForwardReport, exportForward, parseFreeze, readExclusions, readPairs } from "../scripts/forward-export.ts";
import { FACT_SPECS, renderFacts } from "../scripts/facts.ts";
import { ForwardStore } from "../src/forward/index.ts";
import { mcnemarExact } from "../src/forward/analysis.ts";
import type { ForwardPair } from "../src/types.ts";
import { loadForward, loadPrereg } from "../web/lib/forward.ts";

const ROOT = join(import.meta.dir, "..");
const REAL_EXCLUSIONS = join(ROOT, "reports/self/forward-exclusions.json");
const FREEZE = join(ROOT, "experiments/FREEZE.txt");
const tmp = mkdtempSync(join(tmpdir(), "roster-forward-export-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const pair = (task_id: string, pass_old: boolean, pass_new: boolean, cost_old: number | null, cost_new: number | null, extra: Partial<ForwardPair> = {}): ForwardPair => ({
  task_id, setup_old: "B", setup_new: "E", pass_old, pass_new, cost_old, cost_new,
  merged: pass_old !== pass_new ? (pass_old ? "old" : "new") : null, blind_labels: { X: "old", Y: "new" }, seed: 1, ...extra,
});

/** Five pairs: a wave-A both-fail (seq < 0), the excluded F11, one discordant each way, one both-pass. */
function fixtureDb(): string {
  const path = join(tmp, `forward-${Math.random().toString(36).slice(2)}.db`);
  const store = new ForwardStore(path);
  store.addPair(pair("F12", true, false, 1.5, 2.5, { merged_reason: "pass_beats_fail", secondary: "old" }));
  store.addPair(pair("F15", false, true, 3, 1, { merged_reason: "pass_beats_fail", secondary: "new" }));
  store.addPair(pair("F16", true, true, 2, 2.25, { merged: "new", merged_reason: "judge", secondary: "new" }));
  store.addPair(pair("F11", false, false, 0, 0, { merged_reason: "both_failed", secondary: "none" }));
  store.addPair(pair("F01", false, false, 4, null, { merged_reason: "both_failed" }));
  store.db.exec("UPDATE forward_pairs SET seq = -10 WHERE task_id = 'F01'"); // wave-A rows are copied in with seq < 0
  store.db.close();
  return path;
}

/** Just the real F11 exclusion, so the fixture has exactly one excluded pair. */
function f11Exclusions(): string {
  const real = JSON.parse(readFileSync(REAL_EXCLUSIONS, "utf8"));
  const path = join(tmp, "exclusions-f11.json");
  writeFileSync(path, JSON.stringify({ ...real, exclusions: real.exclusions.filter((e: { task: string }) => e.task === "F11") }));
  return path;
}

const sha = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

describe("exportForward", () => {
  const db = fixtureDb();
  const before = sha(db);
  const filesBefore = readdirSync(tmp).sort();
  const reports = join(tmp, "reports");
  const out = join(reports, "self");
  const report = exportForward({ db, exclusions: f11Exclusions(), freeze: FREEZE, out });

  test("H1 summary over pass_old/pass_new with the exclusion applied", () => {
    expect(report.summary).toMatchObject({ n: 4, excludedCount: 1, newOnly: 1, oldOnly: 1, both: 1, neither: 1 });
    expect(report.summary.p).toBe(mcnemarExact(1, 1));
    expect(report.summary.wording).toBe("1 vs 1 passed, p = 1.000; no claim: n = 4 < 24");
    expect(report.pairs).toEqual({ n: 4, recorded: 5, excluded: 1 });
    expect(report.mcnemar).toEqual({ new_only: 1, old_only: 1, both: 1, neither: 1, p: report.summary.p });
    expect(report.wording).toBe(report.summary.wording);
    // Costs as stored; F01 lacks a new cost and F11 is excluded, so three pairs carry both.
    expect(report.cost_p).toBe(report.summary.costP);
    expect(report.cost_p).not.toBeNull();
  });

  test("rows in seq order, with the excluded reason and the merge", () => {
    expect(report.rows.map((r) => r.task)).toEqual(["F01", "F12", "F15", "F16", "F11"]);
    const f11 = report.rows.find((r) => r.task === "F11")!;
    expect(f11.excluded).toContain("network outage");
    expect(report.rows.find((r) => r.task === "F12")).toEqual({ task: "F12", old: true, new: false, costOld: 1.5, costNew: 2.5, merged: "old" });
    expect(report.rows.find((r) => r.task === "F01")).toEqual({ task: "F01", old: false, new: false, costOld: 4, costNew: null, merged: null });
  });

  test("secondary outcomes are counted separately over counted pairs; no build-only merges recorded", () => {
    expect(report.secondary).toEqual({ old: 1, new: 2, tie: 0, none: 0, unrecorded: 1 });
    expect(report.build_only_merges).toBe(0);
    expect(report.sensitivity).toBeNull();
  });

  test("the database is opened read-only", () => {
    expect(sha(db)).toBe(before);
    const name = db.split("/").pop()!;
    expect(readdirSync(tmp).filter((f) => !filesBefore.includes(f) && f.startsWith(name))).toEqual([]);
  });

  test("loadForward parses forward.json", () => {
    const parsed = loadForward(JSON.parse(readFileSync(join(out, "forward.json"), "utf8")));
    expect(parsed.summary).toEqual({ n: 4, wording: report.wording, skipped: 0 });
    expect(parsed.rows).toHaveLength(5);
    expect(parsed.rows.find((r) => r.task === "F11")!.excluded).toBe(report.rows.find((r) => r.task === "F11")!.excluded!);
  });

  test("prereg.json carries both FREEZE.txt hashes and loadPrereg reads the backlog's", () => {
    const prereg = JSON.parse(readFileSync(join(out, "prereg.json"), "utf8"));
    expect(prereg).toEqual(parseFreeze(readFileSync(FREEZE, "utf8")));
    expect(prereg.backlogSha256).toMatch(/^ac682b23[0-9a-f]{56}$/);
    expect(prereg.acceptanceSha256).toMatch(/^cd45ef43[0-9a-f]{56}$/);
    expect(loadPrereg(prereg)).toBe(prereg.backlogSha256);
  });

  test("facts.ts fills every FORWARD_* fact", () => {
    const specs = FACT_SPECS.filter((s) => s.key.startsWith("FORWARD_"));
    expect(specs.length).toBeGreaterThan(0);
    const text = renderFacts(reports, specs, "ts");
    expect(text).not.toContain("PENDING");
    expect(text).toContain("FORWARD_PAIRS_N = 4 pairs");
    expect(text).toContain("FORWARD_NEW_ONLY = 1 pairs");
    expect(text).toContain("FORWARD_OLD_ONLY = 1 pairs");
    expect(text).toContain("FORWARD_P = 1.000, rounded to 3 decimals");
    expect(text).toContain(`FORWARD_WORDING = ${report.wording}  `);
  });
});

describe("buildForwardReport", () => {
  const pairs = readPairs(fixtureDb());

  test("the full real exclusions file: only F11 matches, the rest are listed as unmatched", () => {
    const r = buildForwardReport(pairs, readExclusions(REAL_EXCLUSIONS));
    expect(r.pairs).toEqual({ n: 4, recorded: 5, excluded: 1 });
    expect(r.unmatched_exclusions).toEqual(["F04", "F05", "F06", "F08"]);
  });

  test("amendment 18's sensitivity analysis counts its exclusions as recorded", () => {
    const r = buildForwardReport(pairs, [{ task: "F01", reason: "F6: inherited base test", amendment: 18 }, { task: "F11", reason: "outage", amendment: 11 }]);
    expect(r.summary).toMatchObject({ n: 3, neither: 0 });
    expect(r.sensitivity).toMatchObject({ n: 4, neither: 1, excludedCount: 1, newOnly: 1, oldOnly: 1 });
  });

  test("build-only merges are counted from merged_reason", () => {
    const r = buildForwardReport(
      pairs.map((p) => (p.task === "F01" ? { ...p, mergedReason: "build-only merge (B)" } : p)),
      [],
    );
    expect(r.build_only_merges).toBe(1);
  });

  test("a database from before amendment 8 (no merged_reason/secondary columns) still exports", () => {
    const path = join(tmp, "old-schema.db");
    const db = new Database(path, { create: true });
    db.exec(`CREATE TABLE forward_pairs (task_id TEXT PRIMARY KEY, setup_old TEXT NOT NULL, setup_new TEXT NOT NULL, pass_old INTEGER NOT NULL,
      pass_new INTEGER NOT NULL, cost_old REAL, cost_new REAL, merged TEXT, blind_labels TEXT NOT NULL, seed INTEGER NOT NULL, seq INTEGER NOT NULL)`);
    db.query("INSERT INTO forward_pairs VALUES ('F02','B','E',1,0,1.0,2.0,'old','{}',1,0)").run();
    db.close();
    const r = buildForwardReport(readPairs(path), []);
    expect(r.mcnemar).toMatchObject({ old_only: 1, new_only: 0 });
    expect(r.secondary.unrecorded).toBe(1);
  });

  test("a missing database is an error, not an empty run", () => {
    const missing = join(tmp, "nope.db");
    expect(() => readPairs(missing)).toThrow("no database");
    expect(existsSync(missing)).toBe(false);
  });

  test("parseFreeze rejects text without both hashes", () => {
    expect(() => parseFreeze("forward-backlog.md sha256 " + "a".repeat(64))).toThrow();
  });
});
