import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSetups } from "../src/setups/registry";

let root: string;
const base = { harness: "claude-code", rules: "setups/rules/default.md" };
const REF = "$" + "{FAKE_KEY}";
const cand = (id: string) => ({
  ...base,
  id,
  label: `cand ${id}`,
  model: `m-${id}`,
  env: { ANTHROPIC_BASE_URL: "https://api.example.com/anthropic", ANTHROPIC_AUTH_TOKEN: REF },
});
const put = (rel: string, obj: unknown) => writeFileSync(join(root, rel), JSON.stringify(obj));

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "setups-"));
  mkdirSync(join(root, "setups", "candidates"), { recursive: true });
  for (const id of ["A", "B", "C"]) put(`setups/${id}.json`, { ...base, id, label: `setup ${id}`, model: `m-${id}` });
  put("setups/D.json", { ...base, id: "D", label: "setup D", model: "m-D", append_rules: "setups/rules/strict.md" });
  put("setups/candidates/F.json", cand("F"));
  put("setups/candidates/E.json", cand("E"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("loadSetups", () => {
  test("A-D are non-candidates, sorted, D has extraRulesPath", () => {
    const s = loadSetups(root, { FAKE_KEY: "sekret" });
    expect(s.map((x) => x.id)).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(s.filter((x) => !x.candidate).map((x) => x.id)).toEqual(["A", "B", "C", "D"]);
    expect(s.find((x) => x.id === "A")!.extraRulesPath).toBeNull();
    expect(s.find((x) => x.id === "D")!.extraRulesPath).toBe(join(root, "setups/rules/strict.md"));
    expect(s[0]!.rulesPath).toBe(join(root, "setups/rules/default.md"));
    expect(s[0]!.env).toEqual({});
  });

  test("E/F are candidates with env resolved from the given env", () => {
    const s = loadSetups(root, { FAKE_KEY: "sekret" });
    for (const id of ["E", "F"]) {
      const c = s.find((x) => x.id === id)!;
      expect(c.candidate).toBe(true);
      expect(c.env.ANTHROPIC_AUTH_TOKEN).toBe("sekret");
      expect(c.label).toBe(`cand ${id}`);
    }
  });

  test("missing var gives unavailable label and empty env, without throwing or leaking", () => {
    const s = loadSetups(root, { OTHER: "sekret" });
    const e = s.find((x) => x.id === "E")!;
    expect(e.env).toEqual({});
    expect(e.label).toBe("cand E (unavailable: FAKE_KEY not set)");
    expect(e.candidate).toBe(true);
    expect(JSON.stringify(s)).not.toContain("sekret");
  });
});
