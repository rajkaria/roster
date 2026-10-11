import { expect, test } from "bun:test";
import { formatP, summariseReasons } from "../web/lib/result";

test("p-values print to 3 decimals", () => {
  expect(formatP(0.031250000000000014)).toBe("p = 0.031");
  expect(formatP(8.8e-6)).toBe("p < 0.001");
});

test("gate reasons with UUIDs become a plain summary with the same counts", () => {
  const out = summariseReasons([
    "hidden_pass 0 < incumbent 1",
    "1 regression(s) after reruns: ea846f90-734e-4fb0-bd01-0ce8658c6b0c",
    "1 scope violation(s): 8d77769a-b6f0-44cb-b3d4-928acc638e1b",
  ]);
  expect(out).toBe("fewer hidden-test passes than the incumbent (0 vs 1); 1 regression; 1 scope violation");
  expect(summariseReasons(["2 regression(s) after reruns: a, b"])).toBe("2 regressions");
});
