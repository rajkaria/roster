import { describe, expect, test } from "bun:test";
import prices from "../src/price/prices.json";
import { DEEPSEEK_ROWS, isPeak, OFF_PEAK_FACTOR, priceDeepSeek } from "../src/price/deepseek.ts";

const M = 1_000_000;
// 2026-10-10 is a Saturday, 2026-10-11 a Sunday, 2026-10-12 a Monday, 2026-10-16 a Friday (UTC).
const MON = "2026-10-12";
const SAT = "2026-10-10";
const SUN = "2026-10-11";
const FRI = "2026-10-16";
const at = (iso: string) => new Date(iso);

describe("peak window boundaries (UTC, Monday to Friday)", () => {
  test.each([
    [`${MON}T01:00:00.000Z`, true],
    [`${MON}T03:59:59.999Z`, true],
    [`${MON}T04:00:00.000Z`, false],
    [`${MON}T05:59:59.999Z`, false],
    [`${MON}T06:00:00.000Z`, true],
    [`${MON}T09:59:59.999Z`, true],
    [`${MON}T10:00:00.000Z`, false],
    [`${MON}T00:59:59.999Z`, false],
    [`${MON}T23:30:00.000Z`, false],
  ])("%s is peak=%p", (iso, peak) => {
    expect(isPeak(at(iso))).toBe(peak);
  });

  test("Friday peak hours are peak", () => {
    expect(isPeak(at(`${FRI}T02:00:00.000Z`))).toBe(true);
    expect(isPeak(at(`${FRI}T07:00:00.000Z`))).toBe(true);
  });

  test("the window is read in UTC, whatever the host timezone", () => {
    // 01:00 UTC is 09:00 in Shanghai and 21:00 the previous day in New York; the instant is what counts.
    expect(isPeak(new Date(Date.UTC(2026, 9, 12, 1, 0)))).toBe(true);
    expect(isPeak(new Date(Date.UTC(2026, 9, 12, 0, 59)))).toBe(false);
  });
});

describe("weekends are always off-peak", () => {
  test("Saturday inside the peak hours is off-peak", () => {
    expect(isPeak(at(`${SAT}T02:00:00.000Z`))).toBe(false);
    expect(isPeak(at(`${SAT}T07:00:00.000Z`))).toBe(false);
  });

  test("Sunday inside the peak hours is off-peak", () => {
    expect(isPeak(at(`${SUN}T02:00:00.000Z`))).toBe(false);
    expect(isPeak(at(`${SUN}T08:00:00.000Z`))).toBe(false);
  });

  test("the Monday that follows a weekend is peak again", () => {
    expect(isPeak(at(`${MON}T02:00:00.000Z`))).toBe(true);
  });
});

describe("priceDeepSeek: peak and off-peak arithmetic", () => {
  test("deepseek-v4-pro at peak: cache miss $1.32, cache hit $0.044, output $3.96 per 1M", () => {
    const r = priceDeepSeek("deepseek-v4-pro", { input: M, output: M, cache_read: M }, at(`${MON}T02:00:00.000Z`));
    // 1.32 + 3.96 + 0.044
    expect(r?.usd).toBeCloseTo(5.324, 10);
    expect(r?.row_id).toBe("deepseek-v4-pro");
    expect(r?.peak).toBe(true);
  });

  test("deepseek-v4-pro off-peak is exactly half the peak price", () => {
    const counts = { input: M, output: M, cache_read: M };
    const peak = priceDeepSeek("deepseek-v4-pro", counts, at(`${MON}T02:00:00.000Z`));
    const off = priceDeepSeek("deepseek-v4-pro", counts, at(`${MON}T05:00:00.000Z`));
    // 0.66 + 1.98 + 0.022
    expect(off?.usd).toBeCloseTo(2.662, 10);
    expect(off?.usd).toBeCloseTo((peak?.usd ?? NaN) * OFF_PEAK_FACTOR, 10);
    expect(off?.peak).toBe(false);
  });

  test("deepseek-flash at peak: cache miss $0.30, output $1.20 per 1M", () => {
    const r = priceDeepSeek("deepseek-flash", { input: M, output: M }, at(`${MON}T07:00:00.000Z`));
    expect(r?.usd).toBeCloseTo(1.5, 10);
    expect(r?.row_id).toBe("deepseek-flash");
  });

  test("a weekend run is priced off-peak even inside the peak hours", () => {
    const r = priceDeepSeek("deepseek-flash", { input: M, output: M }, at(`${SAT}T07:00:00.000Z`));
    expect(r?.usd).toBeCloseTo(0.75, 10);
    expect(r?.peak).toBe(false);
  });

  test("zero counts contribute nothing", () => {
    expect(priceDeepSeek("deepseek-flash", { input: 0, output: 0 }, at(`${MON}T02:00:00.000Z`))?.usd).toBe(0);
  });
});

describe("cache hit versus cache miss input", () => {
  test("a cache hit bills at the cache-hit rate, not the cache-miss rate", () => {
    const hit = priceDeepSeek("deepseek-flash", { input: 0, output: 0, cache_read: M }, at(`${MON}T02:00:00.000Z`));
    const miss = priceDeepSeek("deepseek-flash", { input: M, output: 0 }, at(`${MON}T02:00:00.000Z`));
    expect(hit?.usd).toBeCloseTo(0.006, 10);
    expect(miss?.usd).toBeCloseTo(0.3, 10);
  });

  test("uncached input and cached input in one request are each priced", () => {
    const r = priceDeepSeek("deepseek-v4-pro", { input: 500_000, output: 0, cache_read: 500_000 }, at(`${MON}T02:00:00.000Z`));
    // 0.5 * 1.32 + 0.5 * 0.044
    expect(r?.usd).toBeCloseTo(0.682, 10);
  });

  test("cache writes have no confirmed DeepSeek price, so the cost is null", () => {
    const r = priceDeepSeek("deepseek-flash", { input: 0, output: 0, cache_write: 1000 }, at(`${MON}T02:00:00.000Z`));
    expect(r?.usd).toBeNull();
    expect(r?.row_id).toBe("deepseek-flash");
  });
});

describe("unknown models", () => {
  test("a non-DeepSeek model returns null", () => {
    expect(priceDeepSeek("claude-opus-5-5", { input: M, output: M }, at(`${MON}T02:00:00.000Z`))).toBeNull();
    expect(priceDeepSeek("gpt-6-astra", { input: M, output: M }, at(`${MON}T02:00:00.000Z`))).toBeNull();
  });

  test("an unlisted DeepSeek model returns null", () => {
    expect(priceDeepSeek("deepseek-unknown", { input: M, output: M }, at(`${MON}T02:00:00.000Z`))).toBeNull();
  });

  test("an empty model id returns null", () => {
    expect(priceDeepSeek("", { input: 1, output: 1 }, at(`${MON}T02:00:00.000Z`))).toBeNull();
  });
});

describe("DeepSeek price rows", () => {
  test("both candidate models have a row with the DeepSeek pricing URL and a checked_on date", () => {
    for (const id of ["deepseek-flash", "deepseek-v4-pro"]) {
      const row = DEEPSEEK_ROWS.find((r) => r.id === id);
      expect(row).toBeDefined();
      expect(row?.source_url).toBe("https://api-docs.deepseek.com/quick_start/pricing");
      expect(row?.checked_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test("the rows hold peak rates as printed on the pricing page", () => {
    expect(DEEPSEEK_ROWS.find((r) => r.id === "deepseek-flash")).toMatchObject({ input: 0.3, output: 1.2, cache_read: 0.006 });
    expect(DEEPSEEK_ROWS.find((r) => r.id === "deepseek-v4-pro")).toMatchObject({ input: 1.32, output: 3.96, cache_read: 0.044 });
  });

  test("prices.json has no DeepSeek row, so priceSession keeps returning null for DeepSeek", () => {
    expect(prices.rows.some((r) => r.model_pattern.startsWith("deepseek"))).toBe(false);
  });
});
