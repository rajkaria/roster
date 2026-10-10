import { describe, expect, it } from "bun:test";
import { loadBook } from "../../../web/lib/book.ts";

const rows = [
  {
    setup: "setup-1",
    setup_id: "setup-1",
    label: "Baseline",
    monthly: 1234.56,
    spend_usd: 1234.56,
    perChange: 0.42,
    unattended: true,
  },
  {
    setup: "setup-2",
    setup_id: "setup-2",
    label: "Candidate",
    monthly: null,
    spend_usd: null,
    perChange: null,
    unattended: false,
  },
];

describe("loadBook", () => {
  it("formats row money and percent values", () => {
    const result = loadBook({ rows, setups: rows });

    expect(result.rows.length).toBe(2);

    expect(result.rows[0].setup).toBe("setup-1");
    expect(result.rows[0].label).toBe("Baseline");
    expect(result.rows[0].monthly).toBe("$1,234.56");
    expect(result.rows[0].perChange).toBe("42.0%");

    expect(result.rows[1].monthly).toBe("n/a");
    expect(result.rows[1].perChange).toBe("n/a");
  });

  it("formats scenario hire and scale as money", () => {
    const result = loadBook({
      rows: [],
      setups: [],
      scenario: { hire: 1234.56, scale: null },
    });

    expect(result.scenario).toEqual({ hire: "$1,234.56", scale: "n/a" });
  });

  it("returns empty state when book.json is absent", () => {
    expect(loadBook(null)).toEqual({ rows: [], scenario: null, shareUrl: null });
  });

  it("keeps shareUrl only when it is an https URL on cfo.ai", () => {
    const base = { rows: [], setups: [] };

    expect(loadBook({ ...base, shareUrl: "https://cfo.ai/reports/1" }).shareUrl).toBe(
      "https://cfo.ai/reports/1",
    );

    expect(loadBook({ ...base, shareUrl: "http://cfo.ai/reports/1" }).shareUrl).toBeNull();
    expect(loadBook({ ...base, shareUrl: "https://example.com/reports/1" }).shareUrl).toBeNull();
    expect(loadBook({ ...base, shareUrl: "not a url" }).shareUrl).toBeNull();
  });
});
