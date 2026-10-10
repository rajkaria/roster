import { describe, expect, test } from "bun:test";
import { erfc, mantelHaenszel } from "../src/review/stats.ts";
import { suspect, type SetupOutcome } from "../src/review/suspect.ts";
import type { Tercile } from "../src/types.ts";

let seq = 0;
/** Builds `total` mature outcomes for a setup in a tercile, `bad` of them reverted. Deterministic. */
function group(setup: string, tercile: Tercile, total: number, bad: number): SetupOutcome[] {
  return Array.from({ length: total }, (_, i) => ({
    session_id: `s${seq++}`,
    setup_id: setup,
    status: "mature" as const,
    survival: 1,
    reverted: i < bad,
    rework_human: 0,
    rework_agent: 0,
    unattended: null,
    tests_at_commit: null,
    difficulty: tercile,
    tercile,
  }));
}

describe("mantelHaenszel against hand-computed values", () => {
  // Strata (a,b,c,d): (10,10,5,15) n=40 and (6,4,3,7) n=20.
  // OR = (150/40 + 42/20) / (50/40 + 12/20) = 5.85 / 1.85.
  // chi2 (continuity) = (|16 - 12| - 0.5)^2 / (150000/62400 + 9900/7600) = 12.25 / 3.70648 = 3.3050 -> p = 0.0691.
  const r = mantelHaenszel([
    { a: 10, b: 10, c: 5, d: 15 },
    { a: 6, b: 4, c: 3, d: 7 },
  ]);
  test("odds ratio", () => expect(r.or).toBeCloseTo(5.85 / 1.85, 10));
  test("RBG confidence interval", () => {
    expect(r.ci95[0]).toBeCloseTo(1.06863, 3);
    expect(r.ci95[1]).toBeCloseTo(9.35708, 3);
  });
  test("p from the corrected chi-square", () => expect(r.p).toBeCloseTo(0.0691, 3));
  test("single 2x2 reduces to the cross-product ratio", () => {
    expect(mantelHaenszel([{ a: 6, b: 4, c: 4, d: 16 }]).or).toBeCloseTo(6, 10);
  });
  test("zero cell is handled, not infinite", () => {
    expect(Number.isFinite(mantelHaenszel([{ a: 5, b: 0, c: 0, d: 5 }]).or)).toBe(true);
  });
  test("erfc known values", () => {
    expect(erfc(0)).toBeCloseTo(1, 6);
    expect(erfc(1)).toBeCloseTo(0.1572992, 6);
  });
});

describe("suspect", () => {
  test("confounded fixture: raw would flag X, matched does not", () => {
    // X only got hard tasks; bad rate is 50% in the hard tercile for everyone.
    const rows = [
      ...group("X", 3, 16, 8),
      ...group("Y", 1, 40, 4),
      ...group("Y", 2, 40, 8),
      ...group("Y", 3, 16, 8),
    ];
    const res = suspect(rows);
    expect(res.setupId).toBeNull();
    expect(res.label).toBe("no suspect");
    // Unmatched, X looks bad (all of its sessions are hard): 8/16 bad vs 20/96 for the rest.
    const rawX = mantelHaenszel([{ a: 8, b: 8, c: 20, d: 76 }]);
    expect(rawX.or).toBeGreaterThan(1);
    expect(rawX.p).toBeLessThan(0.05);
    // Stratified by tercile, only the hard stratum is informative and it is 8/16 vs 8/16.
    const matchedX = mantelHaenszel([
      { a: 0, b: 0, c: 4, d: 36 },
      { a: 0, b: 0, c: 8, d: 32 },
      { a: 8, b: 8, c: 8, d: 8 },
    ]);
    expect(matchedX.or).toBeCloseTo(1, 10);
    expect(matchedX.p).toBeGreaterThan(0.05);
  });

  test("true effect: X flagged with p < 0.05", () => {
    const rows: SetupOutcome[] = [];
    for (const t of [1, 2, 3] as Tercile[]) rows.push(...group("X", t, 10, 6), ...group("Y", t, 20, 4));
    const res = suspect(rows);
    expect(res.setupId).toBe("X");
    expect(res.label).toBe("suspect (level A, observational)");
    expect(res.p!).toBeLessThan(0.05);
    expect(res.or!).toBeGreaterThan(1);
    expect(res.ci95![0]).toBeGreaterThan(1);
    expect(res.n).toBe(30);
  });

  test("insufficient data below 8 mature sessions", () => {
    const res = suspect(group("X", 1, 7, 7));
    expect(res.label).toBe("insufficient data");
    expect(res.setupId).toBeNull();
  });

  test("too_young sessions do not count toward the 8", () => {
    const young = group("X", 1, 8, 8).map((o) => ({ ...o, status: "too_young" as const }));
    expect(suspect(young).label).toBe("insufficient data");
  });

  test("bad also covers rework_human > 0.3", () => {
    const rows: SetupOutcome[] = [];
    for (const t of [1, 2, 3] as Tercile[]) {
      rows.push(...group("X", t, 10, 0).map((o, i) => ({ ...o, rework_human: i < 6 ? 0.31 : 0.3 })));
      rows.push(...group("Y", t, 20, 4));
    }
    expect(suspect(rows).setupId).toBe("X");
  });
});
