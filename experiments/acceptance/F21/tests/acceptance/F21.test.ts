import { test, expect } from "bun:test";
import { renderResults } from "../../scripts/readme-facts.ts";

const START = "<!-- facts:start -->";
const END = "<!-- facts:end -->";

test("replaces text between markers with one bullet per key", () => {
  const readme = `# Results\n\n${START}\nold\n${END}\n\nTail`;
  const facts = [
    "ALPHA = one  (source: review)",
    "BETA = two  (source: review)",
    "PENDING = PENDING  (source: review)",
  ].join("\n");

  expect(renderResults(readme, facts, ["ALPHA", "BETA", "PENDING"])).toBe(
    `# Results\n\n${START}\n- ALPHA: one\n- BETA: two\n- PENDING: pending\n${END}\n\nTail`,
  );
});

test("missing keys render pending", () => {
  const readme = `${START}\nold\n${END}`;
  const facts = `KNOWN = value  (source: review)`;

  expect(renderResults(readme, facts, ["KNOWN", "MISSING"])).toBe(
    `${START}\n- KNOWN: value\n- MISSING: pending\n${END}`,
  );
});

test("returns the README unchanged when markers are absent", () => {
  const readme = `# No markers\n\ncontent`;
  const facts = `KEY = value  (source: review)`;

  expect(renderResults(readme, facts, ["KEY"])).toEqual(readme);
});

test("running twice is idempotent", () => {
  const facts = [
    "ALPHA = one  (source: review)",
    "BETA = two  (source: review)",
  ].join("\n");
  const readme = `# Results\n\n${START}\nold\n${END}\n\nTail`;

  const once = renderResults(readme, facts, ["ALPHA", "BETA"]);
  const twice = renderResults(once, facts, ["ALPHA", "BETA"]);

  expect(twice).toBe(once);
});
