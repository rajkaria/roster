import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBook } from "../web/lib/book";
import { bookFromReview, carriedCfo, main, shareUrlFromPlan } from "../scripts/book-self";

const ROOT = join(import.meta.dir, "..");
const DIR = mkdtempSync(join(tmpdir(), "book-self-share-"));
const BOOK = "https://app.cfo.ai/s/lITFLQ-6eGU21WPi";

describe("shareUrlFromPlan", () => {
  test("reads shareUrls.book from cfo-plan.json", () => {
    expect(shareUrlFromPlan({ shareUrls: { book: BOOK, plan: "https://app.cfo.ai/s/x" } })).toBe(BOOK);
  });

  test("anything but an https URL on cfo.ai is null", () => {
    for (const plan of [
      null,
      {},
      { shareUrls: null },
      { shareUrls: { book: null } },
      { shareUrls: { book: 42 } },
      { shareUrls: { book: "not a url" } },
      { shareUrls: { book: "http://app.cfo.ai/s/x" } },
      { shareUrls: { book: "https://cfo.ai.evil.com/s/x" } },
    ]) {
      expect(shareUrlFromPlan(plan)).toBeNull();
    }
  });

  test("/book keeps the link it is given", () => {
    expect(loadBook({ rows: [], shareUrl: shareUrlFromPlan({ shareUrls: { book: BOOK } }) }).shareUrl).toBe(BOOK);
  });
});

const review = {
  id: "r",
  repo: "x/y",
  setups: [{ setup_id: "a", label: "A", sessions: 4, spend_usd: 2, unattended: 0.5, surviving_changes: 3 }],
};
const sessions = [{ started_at: "2026-10-01T00:00:00Z", ended_at: "2026-10-11T00:00:00Z" }];
const verified = { written: true, verified: true, error: null };

describe("carriedCfo", () => {
  const file = bookFromReview(review, sessions, null, "r.json");

  test("an earlier outcome holds when the book is unchanged", () => {
    expect(carriedCfo({ ...file, cfo: verified }, file)).toEqual(verified);
  });

  test("a changed book drops the earlier outcome", () => {
    const changed = bookFromReview({ ...review, setups: [{ ...review.setups[0]!, spend_usd: 3 }] }, sessions, null, "r.json");
    expect(carriedCfo({ ...file, cfo: verified }, changed)).toBeNull();
  });

  test("no earlier file, or one without a book, carries nothing", () => {
    expect(carriedCfo(null, file)).toBeNull();
    expect(carriedCfo({ cfo: verified }, file)).toBeNull();
  });
});

describe("main without --write", () => {
  test("keeps a verified outcome for the same book and takes the share link from cfo-plan.json", async () => {
    const out = join(DIR, "book.json");
    const first = await main([], { out });
    expect(first.cfo.verified).toBe(false);
    writeFileSync(out, JSON.stringify({ ...first, cfo: verified }));
    const again = await main([], { out });
    expect(again.cfo).toEqual(verified);
    const plan = JSON.parse(readFileSync(join(ROOT, "reports/self/cfo-plan.json"), "utf8"));
    expect(again.shareUrl).toBe(shareUrlFromPlan(plan));
  });
});
