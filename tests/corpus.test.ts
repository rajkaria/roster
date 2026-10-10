import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  detectTestCommand,
  groupByRepo,
  isOsiLicense,
  rankCandidates,
  scoreCandidate,
  type Candidate,
} from "../scripts/corpus-find";

// Recorded from `gh api search/commits` (scripts/corpus-find.ts --record), authors redacted.
const recorded = JSON.parse(readFileSync(new URL("../reports/corpus/sample-search.json", import.meta.url), "utf8"));

describe("groupByRepo (recorded gh api response)", () => {
  const groups = groupByRepo([recorded]);

  test("groups commits by public repo with unique checkpoint ids", () => {
    expect(groups.size).toBeGreaterThan(0);
    for (const [name, g] of groups) {
      expect(name).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(g.commits).toBeGreaterThan(0);
      expect(g.checkpoints.length).toBeGreaterThan(0);
      expect(new Set(g.checkpoints).size).toBe(g.checkpoints.length);
      for (const id of g.checkpoints) expect(id).toMatch(/^[0-9A-Za-z]{12,}$/);
    }
  });

  test("fixture carries no author emails", () => {
    expect(JSON.stringify(recorded)).not.toMatch(/@[\w-]+\.[a-z]{2,}/i);
  });

  test("skips private repos and items without a trailer", () => {
    const g = groupByRepo([
      {
        items: [
          { sha: "a", repository: { full_name: "x/priv", private: true }, commit: { message: "m\n\nEntire-Checkpoint: ABCDEFGHJKMN" } },
          { sha: "b", repository: { full_name: "x/none", private: false }, commit: { message: "no trailer" } },
        ],
      },
    ]);
    expect(g.size).toBe(0);
  });
});

describe("isOsiLicense", () => {
  test("accepts OSI SPDX ids, rejects others", () => {
    expect(isOsiLicense("MIT")).toBe(true);
    expect(isOsiLicense("Apache-2.0")).toBe(true);
    expect(isOsiLicense("NOASSERTION")).toBe(false);
    expect(isOsiLicense(null)).toBe(false);
    expect(isOsiLicense("CC-BY-NC-4.0")).toBe(false);
  });
});

describe("detectTestCommand", () => {
  test("package.json test script, bun vs npm", () => {
    const pkg = JSON.stringify({ scripts: { test: "vitest run" } });
    expect(detectTestCommand(["package.json", "bun.lock"], pkg)).toBe("bun run test");
    expect(detectTestCommand(["package.json"], pkg)).toBe("npm test");
  });
  test("ignores the npm placeholder test script", () => {
    const pkg = JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } });
    expect(detectTestCommand(["package.json"], pkg)).toBeNull();
  });
  test("other ecosystems", () => {
    expect(detectTestCommand(["Cargo.toml"])).toBe("cargo test");
    expect(detectTestCommand(["go.mod"])).toBe("go test ./...");
    expect(detectTestCommand(["pyproject.toml", "tests"])).toBe("pytest");
    expect(detectTestCommand(["README.md"])).toBeNull();
  });
});

describe("score and rank", () => {
  const base: Candidate = {
    repo: "a/a", url: "", stars: 1, language: "TypeScript", license: "MIT",
    sessions: 10, distinct_setups: 3, harnesses: ["claude"], models: ["m"],
    test_command: "npm test", score: 0,
  };
  test("score = sessions x distinct setups", () => {
    expect(scoreCandidate(base)).toBe(30);
  });
  test("filters non-OSI and no-test repos, ranks by score then stars", () => {
    const list = rankCandidates([
      { ...base, repo: "a/low", sessions: 2 },
      { ...base, repo: "a/high", sessions: 20 },
      { ...base, repo: "a/nolic", license: "NOASSERTION", sessions: 99 },
      { ...base, repo: "a/notest", test_command: null, sessions: 99 },
      { ...base, repo: "a/zero", sessions: 0 },
    ]);
    expect(list.map((c) => c.repo)).toEqual(["a/high", "a/low"]);
    expect(list[0]?.score).toBe(60);
  });
});
