// T47: the landing page's data helper renders the table straight from a review file.
// Fixtures are the real published review (reports/rajkaria__roster/review.json) and clones of it with fields overridden.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forwardStarted, landingRows, landingTotals } from "../web/components/LandingData.tsx";
import type { Review } from "../web/lib/types.ts";

const ROOT = join(import.meta.dir, "..");
const REAL = join(ROOT, "reports", "rajkaria__roster", "review.json");
const load = (): Review => JSON.parse(readFileSync(REAL, "utf8"));

describe("landingRows", () => {
  test("one row per setup, in file order, with sessions and spend from the file", () => {
    const review = load();
    const rows = landingRows(review);
    expect(rows.length).toBe(review.setups.length);
    rows.forEach((r, i) => {
      const s = review.setups[i]!;
      expect(r.setup_id).toBe(s.setup_id);
      expect(r.label).toBe(s.label);
      expect(r.sessions).toBe(s.sessions);
      if (s.spend_usd === null) expect(r.spend).toStartWith("unknown");
      else expect(r.spend).toBe(`${s.spend_lower_bound ? "≥ " : ""}$${s.spend_usd.toFixed(2)}`);
      if (s.mature_sessions === 0) expect(r.unattended).toBe("too young");
    });
  });

  test("unknown spend is never shown as $0", () => {
    const review = load();
    const s = { ...review.setups[0]!, spend_usd: null, priced_sessions: 1, sessions: 3 };
    const [row] = landingRows({ ...review, setups: [s] });
    expect(row!.spend).toBe("unknown (1/3 priced)");
    expect(landingTotals({ ...review, setups: [s, ...review.setups.slice(1)] }).spend).toStartWith("unknown");
  });

  test("mature setups show unattended as a percentage", () => {
    const review = load();
    const s = { ...review.setups[0]!, mature_sessions: 4, unattended: 0.25 };
    expect(landingRows({ ...review, setups: [s] })[0]!.unattended).toBe("25%");
  });
});

describe("landingTotals", () => {
  test("sums sessions and spend across setups", () => {
    const review = load();
    const t = landingTotals(review);
    expect(t.sessions).toBe(review.setups.reduce((n, s) => n + s.sessions, 0));
    const usd = review.setups.reduce((n, s) => n + (s.spend_usd ?? 0), 0);
    const lower = review.setups.some((s) => s.spend_lower_bound);
    expect(t.spend).toBe(`${lower ? "≥ " : ""}$${usd.toFixed(2)}`);
  });
});

describe("forwardStarted", () => {
  test("false until self/forward.json exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-landing-"));
    try {
      expect(forwardStarted(dir)).toBe(false);
      mkdirSync(join(dir, "self"));
      writeFileSync(join(dir, "self", "forward.json"), "[]");
      expect(forwardStarted(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("page source", () => {
  test("no number literals in the landing page or its sections", () => {
    for (const f of ["web/app/page.tsx", "web/components/LandingSections.tsx"]) {
      const src = readFileSync(join(ROOT, f), "utf8");
      expect(src.match(/\b\d+(\.\d+)?\b/g)).toBeNull();
    }
  });

  test("no em dashes in landing copy", () => {
    for (const f of ["web/app/page.tsx", "web/components/LandingSections.tsx", "web/components/LandingData.tsx"]) {
      expect(readFileSync(join(ROOT, f), "utf8")).not.toContain("—");
    }
  });
});
