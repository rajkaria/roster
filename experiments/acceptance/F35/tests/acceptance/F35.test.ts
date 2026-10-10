import { test, expect } from "bun:test";
import { usd, pct, pValue } from "../../web/lib/format.ts";

test("usd formats dollars with commas and two decimals", () => {
  expect(usd(1234.56)).toBe("$1,234.56");
});

test("usd formats negative amounts with a minus sign", () => {
  expect(usd(-3)).toBe("−$3.00");
});

test("usd formats null as n/a", () => {
  expect(usd(null)).toBe("n/a");
});

test("pct formats a share as a one-decimal percentage", () => {
  expect(pct(0.4213)).toBe("42.1%");
});

test("pValue uses a less-than format below 0.001", () => {
  expect(pValue(0.0005, 20)).toBe("p < 0.001");
});

test("pValue reports three decimals for p >= 0.001", () => {
  expect(pValue(0.031, 20)).toBe("p = 0.031");
});

test("pValue appends the not significant note when p >= 0.05", () => {
  expect(pValue(0.05, 30)).toBe("p = 0.050 (not significant at n = 30)");
});

test("pValue rounds to three decimals and appends the note when not significant", () => {
  expect(pValue(0.4213, 10)).toBe("p = 0.421 (not significant at n = 10)");
});
