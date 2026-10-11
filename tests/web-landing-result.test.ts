// T80: the landing page's "The result" section. Fixtures are copied from the real reports/self files by this test,
// then altered to odd values, so every assertion shows the strings and counts come from the files.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadResult, loadResultFile } from "../web/lib/result.ts";

const SELF = join(import.meta.dir, "..", "reports", "self");
const real = (p: string) => JSON.parse(readFileSync(join(SELF, p), "utf8"));

function fixture(mutate: (f: any, d1: any, d1b: any) => void) {
  const f = real("forward.json");
  const d1 = real("review-1/decisions.json");
  const d1b = real("review-1b/decision.json");
  mutate(f, d1, d1b);
  return { f, d1, d1b };
}

describe("loadResult", () => {
  test("counts, wording and verdicts come from the files", () => {
    const { f, d1, d1b } = fixture((f, d1, d1b) => {
      f.summary = { ...f.summary, n: 91, newOnly: 77, oldOnly: 55, both: 33, neither: 22, p: 0.4321, wording: "WORDING-X" };
      d1.decisions[0].verdict = "promote-X";
      d1.decisions[0].reasons = ["REASON-1"];
      d1b.verdict = "reject-X";
      d1b.reasons = ["REASON-1B"];
      d1b.hidden_pass = { incumbent: 88, candidate: 66 };
    });
    const r = loadResult(f, d1, d1b);
    expect(r.forward).toEqual({ wording: "WORDING-X", n: 91, newOnly: 77, oldOnly: 55, both: 33, neither: 22, p: 0.4321 });
    expect(r.v1?.verdict).toBe("promote-X");
    expect(r.v1?.reasons).toEqual(["REASON-1"]);
    expect(r.v2?.verdict).toBe("reject-X");
    expect(r.v2?.hiddenPass).toEqual({ incumbent: 88, candidate: 66 });
  });

  test("missing files give null parts, which the component shows as 'forward run in progress'", () => {
    expect(loadResult(undefined, undefined, undefined)).toEqual({ forward: null, v1: null, v2: null });
  });

  test("malformed summary counts give no forward claim", () => {
    const { f, d1, d1b } = fixture((f) => { f.summary.newOnly = "six"; });
    expect(loadResult(f, d1, d1b).forward).toBeNull();
  });
});

describe("LandingResult source", () => {
  const src = readFileSync(join(import.meta.dir, "..", "web", "components", "LandingResult.tsx"), "utf8");
  test("has the fallback and links, and no number literals in its markup", () => {
    expect(src).toContain("forward run in progress");
    expect(src).toContain('href="/experiment"');
    expect(src).toContain("PREREGISTRATION.md");
    const markup = src.slice(src.indexOf("return ("));
    expect(markup.replace(/\{[^}]*\}/g, "").replace(/<[^>]*>/g, "").replace(/\bv\d\b/g, "")).not.toMatch(/\d/);
  });
});

describe("loadResultFile", () => {
  test("reads the three files under dataDir/self", () => {
    const dir = mkdtempSync(join(tmpdir(), "t80-"));
    try {
      mkdirSync(join(dir, "self", "review-1"), { recursive: true });
      mkdirSync(join(dir, "self", "review-1b"), { recursive: true });
      for (const p of ["forward.json", "review-1/decisions.json", "review-1b/decision.json"]) {
        writeFileSync(join(dir, "self", p), readFileSync(join(SELF, p)));
      }
      const r = loadResultFile(dir);
      expect(r.forward?.n).toBe(real("forward.json").summary.n);
      expect(r.v2?.verdict).toBe(real("review-1b/decision.json").verdict);
      expect(r.v1?.verdict).toBe(real("review-1/decisions.json").decisions[0].verdict);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("empty dir gives all-null result", () => {
    const dir = mkdtempSync(join(tmpdir(), "t80-"));
    try {
      expect(loadResultFile(dir)).toEqual({ forward: null, v1: null, v2: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
