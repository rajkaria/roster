import { expect, test } from "bun:test";
import { pct, pValue, usd } from "../web/lib/format";

test("usd", () => {
  expect(usd(1234.56)).toBe("$1,234.56");
  expect(usd(-3)).toBe("−$3.00");
  expect(usd(0)).toBe("$0.00");
  expect(usd(-0.001)).toBe("$0.00");
  expect(usd(null)).toBe("n/a");
});

test("pct", () => {
  expect(pct(0.4213)).toBe("42.1%");
  expect(pct(0.4213, 0)).toBe("42%");
  expect(pct(0.4213, 2)).toBe("42.13%");
  expect(pct(null)).toBe("n/a");
});

test("pValue", () => {
  expect(pValue(0.0004, 30)).toBe("p < 0.001");
  expect(pValue(0.031, 30)).toBe("p = 0.031");
  expect(pValue(0.05, 12)).toBe("p = 0.050 (not significant at n = 12)");
  expect(pValue(0.4, 12)).toBe("p = 0.400 (not significant at n = 12)");
});
