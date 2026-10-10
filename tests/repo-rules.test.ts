import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

test("CLAUDE.md, AGENTS.md and setups/rules/default.md are byte-identical", () => {
  const rules = read("setups/rules/default.md");
  expect(read("CLAUDE.md")).toBe(rules);
  expect(read("AGENTS.md")).toBe(rules);
});

test("every setup definition is complete", () => {
  for (const id of ["A", "B", "C", "D"]) {
    const s = JSON.parse(read(`setups/${id}.json`));
    expect(s.id).toBe(id);
    expect(["claude-code", "codex"]).toContain(s.harness);
    expect(typeof s.model).toBe("string");
    expect(s.rules).toBe("setups/rules/default.md");
  }
  expect(JSON.parse(read("setups/D.json")).append_rules).toBe("setups/rules/strict.md");
});
