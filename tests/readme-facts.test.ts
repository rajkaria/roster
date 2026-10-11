import { expect, test } from "bun:test";
import { renderResults } from "../scripts/readme-facts";

const facts = [
  "# Facts",
  "A = 4.23, rounded to 2 decimals  (source: x.json#$.a, generated now)",
  "B = PENDING  (source: y.json#$.b, generated now)",
].join("\n");
const readme = "intro\n<!-- facts:start -->\nold 99\n<!-- facts:end -->\noutro\n";

test("renders bullets, pending for PENDING and missing", () => {
  const out = renderResults(readme, facts, ["A", "B", "C"]);
  expect(out).toBe(
    "intro\n<!-- facts:start -->\n- A: 4.23, rounded to 2 decimals\n- B: pending\n- C: pending\n<!-- facts:end -->\noutro\n",
  );
  expect(out).not.toContain("old 99");
});

test("markers absent returns unchanged", () => {
  expect(renderResults("no markers", facts, ["A"])).toBe("no markers");
});

test("idempotent", () => {
  const once = renderResults(readme, facts, ["A", "B"]);
  expect(renderResults(once, facts, ["A", "B"])).toBe(once);
});
