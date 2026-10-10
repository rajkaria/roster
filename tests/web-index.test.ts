// T55: /r lists every review under public/data except _sample, sorted by sessions descending.
// Fixtures are the real published review (reports/rajkaria__roster/review.json) cloned into a temp data dir with fields overridden.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Review } from "../web/lib/types.ts";
import { listReviews } from "../web/lib/reviews.ts";

const ROOT = join(import.meta.dir, "..");
const REAL = join(ROOT, "reports", "rajkaria__roster", "review.json");
const base: Review = JSON.parse(readFileSync(REAL, "utf8"));

/** A clone of the real review with its setups' session counts overridden: sessions[i] and mature[i] per setup. */
function clone(repo: string, sessions: number[], mature: number[], extra: Partial<Review> = {}): Review {
  const setups = sessions.map((n, i) => ({ ...base.setups[i % base.setups.length]!, setup_id: `${repo}-${i}`, sessions: n, mature_sessions: mature[i] ?? 0 }));
  return { ...structuredClone(base), repo, setups, ...extra };
}

let dir: string;

function put(name: string, body: unknown) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "review.json"), typeof body === "string" ? body : JSON.stringify(body));
}

function fixtureDir() {
  dir = mkdtempSync(join(tmpdir(), "roster-index-"));
  put("_sample", { ...clone("_sample/_sample", [99], [99]), sample: true });
  put("acme__small", clone("acme/small", [3, 2], [1, 0], { label: "insufficient_data", generated_at: "2026-10-01T10:00:00.000Z" }));
  put("zeta__big", clone("zeta/big", [20, 10, 5], [18, 9, 4], { label: "suspect", suspect: "Z", generated_at: "2026-10-09T08:30:00.000Z" }));
  put("rajkaria__roster", clone("rajkaria/roster", [12, 6], [0, 0], { label: "no_suspect", generated_at: "2026-10-10T18:47:17.074Z" }));
  put("broken__json", "{not json");
  // A dir with no review.json (the self dir holds forward results, not a review).
  mkdirSync(join(dir, "self"), { recursive: true });
  writeFileSync(join(dir, "self", "forward.json"), "{}");
  return dir;
}

describe("listReviews", () => {
  test("lists every review except _sample, sorted by sessions descending", () => {
    fixtureDir();
    try {
      const rows = listReviews(dir);
      expect(rows.map((r) => `${r.owner}/${r.repo}`)).toEqual(["zeta/big", "rajkaria/roster", "acme/small"]);
      expect(rows.some((r) => r.owner === "_sample")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("each row carries sessions, mature sessions, setups, label, generated date and the /r/<owner>/<repo> link", () => {
    fixtureDir();
    try {
      const rows = listReviews(dir);
      expect(rows[0]).toEqual({
        owner: "zeta",
        repo: "big",
        href: "/r/zeta/big",
        sessions: 35,
        mature_sessions: 31,
        setups: 3,
        label: "suspect",
        generated_at: "2026-10-09T08:30:00.000Z",
      });
      expect(rows[1]).toMatchObject({ href: "/r/rajkaria/roster", sessions: 18, mature_sessions: 0, setups: 2, label: "no_suspect" });
      expect(rows[2]).toMatchObject({ href: "/r/acme/small", sessions: 5, mature_sessions: 1, setups: 2, label: "insufficient_data" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ties on sessions fall back to repo name", () => {
    fixtureDir();
    try {
      put("aaa__tie", clone("aaa/tie", [5, 0], [0, 0]));
      put("bbb__tie", clone("bbb/tie", [5], [0]));
      // acme/small, aaa/tie and bbb/tie all have 5 sessions; they sort by name within that tie.
      const names = listReviews(dir).map((r) => `${r.owner}/${r.repo}`);
      expect(names).toEqual(["zeta/big", "rajkaria/roster", "aaa/tie", "acme/small", "bbb/tie"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing data dir gives no rows", () => {
    expect(listReviews(join(tmpdir(), "roster-index-does-not-exist"))).toEqual([]);
  });
});
