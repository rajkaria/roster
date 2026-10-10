import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { difficulty, difficultyFromFeatures, features, terciles, zScores, type DifficultyScore } from "../src/difficulty/index.ts";
import { fanInSize, graphImpact, impactSize, parseImpact, symbolsInHunks } from "../src/difficulty/graph.ts";
import { identify } from "../src/identity/index.ts";
import { parseCheckpoints } from "../src/ingest/parse.ts";
import type { Session } from "../src/types.ts";
import { git, makeFixture } from "./fixtures/make-fixture.ts";

setDefaultTimeout(120_000);

const root = mkdtempSync(join(tmpdir(), "roster-difficulty-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const NO_GRAPH = { entireBin: join(root, "no-such-entire") };
const hasEntire = Bun.which("entire") !== null;

/** A tiny repo with relative imports, committed with the fixture's git env. */
function importRepo(dir: string): { repo: string; sha: string } {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  const files: Record<string, string> = {
    "src/util.ts": "export function helper(x: number): number {\n  return x + 1;\n}\n",
    "src/a.ts": 'import { helper } from "./util.ts";\nexport const a = helper(1);\n',
    "src/b.ts": 'import { helper } from "./util";\nexport const b = helper(2);\n',
    "src/c/index.ts": 'export { a } from "../a.ts";\n',
  };
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "--no-gpg-sign", "-m", "init"]);
  return { repo: dir, sha: git(dir, ["rev-parse", "HEAD"]) };
}

describe("z-scores and terciles", () => {
  test("zScores: mean 0, missing and constant columns score 0", () => {
    const z = zScores([1, 2, 3, null]);
    expect(z[0]! + z[1]! + z[2]!).toBeCloseTo(0);
    expect(z[1]).toBe(0);
    expect(z[3]).toBe(0);
    expect(zScores([5, 5, 5])).toEqual([0, 0, 0]);
  });

  test("difficulty is the mean of four z-scores and orders by size", () => {
    const f = (lines: number, files: number, impact: number, len: number) => ({
      lines_changed: lines,
      files_touched: files,
      impact,
      impact_method: "fan-in" as const,
      first_prompt_len: len,
    });
    const d = difficultyFromFeatures([f(1, 1, 0, 10), f(10, 2, 1, 50), f(100, 3, 2, 90)]);
    expect(d[0]!).toBeLessThan(d[1]!);
    expect(d[1]!).toBeLessThan(d[2]!);
    expect(d[0]! + d[1]! + d[2]!).toBeCloseTo(0);
  });

  test("terciles split by rank into thirds", () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({ session_id: `s${i}`, difficulty: i }));
    const t = terciles(rows);
    expect(rows.map((r) => t.get(r.session_id))).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3]);
  });
});

describe("impact methods", () => {
  test("fan-in counts distinct relative importers at HEAD", () => {
    const { repo } = importRepo(join(root, "imports"));
    expect(fanInSize(repo, ["src/util.ts"])).toBe(2);
    expect(fanInSize(repo, ["src/a.ts"])).toBe(1);
    expect(fanInSize(repo, ["src/b.ts", "src/c/index.ts"])).toBe(0);
  });

  test("symbols come from declarations on the touched hunks", () => {
    const { repo, sha } = importRepo(join(root, "symbols"));
    expect(symbolsInHunks(repo, sha).sort()).toEqual(["a", "b", "helper"]);
  });

  test("graph unavailable → fan-in is used and recorded", () => {
    const { repo, sha } = importRepo(join(root, "nograph"));
    expect(graphImpact(repo, "helper", NO_GRAPH)).toBeNull();
    const r = impactSize(repo, sha, ["src/util.ts"], NO_GRAPH);
    expect(r).toEqual({ size: 2, method: "fan-in", symbols: [] });
  });

  test.skipIf(!hasEntire)("entire graph available → graph is used and recorded", () => {
    const { repo, sha } = importRepo(join(root, "graph"));
    const raw = Bun.spawnSync(["entire", "graph", "impact", "--repo", repo, "--symbol", "helper", "--format", "json"], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });
    const n = parseImpact(raw.stdout.toString());
    expect(n).not.toBeNull();
    expect(n!).toBeGreaterThan(0);
    const r = impactSize(repo, sha, ["src/util.ts"], { timeoutMs: 60_000 });
    expect(r.method).toBe("graph");
    expect(r.symbols.sort()).toEqual(["a", "b", "helper"]);
    expect(r.size).toBeGreaterThanOrEqual(n!);
  });

  test("parseImpact rejects non-impact output", () => {
    expect(parseImpact("not json")).toBeNull();
    expect(parseImpact("{}")).toBeNull();
  });
});

describe("confound fixture (X gets only the hard tasks)", () => {
  let sessions: Session[];
  let scores: DifficultyScore[];
  const tagOf = new Map<string, string>();

  beforeAll(() => {
    const dir = join(root, "confound");
    makeFixture(dir, "confound");
    sessions = parseCheckpoints(dir, "branch", { warn: () => {} }).map((s) => {
      const id = identify(s, dir);
      if (id.tag) tagOf.set(s.id, id.tag.setup);
      return { ...s, setup_id: id.setupId };
    });
    scores = difficulty(sessions, dir, NO_GRAPH);
  });

  const of = (setup: string) => scores.filter((s) => tagOf.get(s.session_id) === setup);

  test("every session is scored; graph unavailable → fan-in recorded on each", () => {
    expect(scores.length).toBe(27);
    expect(new Set(scores.map((s) => s.features.impact_method))).toEqual(new Set(["fan-in"]));
    for (const s of scores) expect(s.features.lines_changed).not.toBeNull();
  });

  test("X's sessions land in the top tercile, never the bottom", () => {
    const x = of("X");
    expect(x.length).toBe(9);
    expect(x.every((s) => s.tercile >= 2)).toBe(true);
    const top = scores.filter((s) => s.tercile === 3);
    const xTop = top.filter((s) => tagOf.get(s.session_id) === "X").length;
    // X holds more of the top tercile than Y and Z, and more than its 1/3 base share.
    expect(xTop).toBeGreaterThan(top.length / 3);
    for (const other of ["Y", "Z"]) expect(xTop).toBeGreaterThan(of(other).filter((s) => s.tercile === 3).length);
    const mean = (r: DifficultyScore[]) => r.reduce((a, s) => a + s.difficulty, 0) / r.length;
    expect(mean(x)).toBeGreaterThan(mean(of("Y")));
    expect(mean(x)).toBeGreaterThan(mean(of("Z")));
  });

  test("small tasks of Y and Z land in the bottom tercile", () => {
    const small = scores.filter((s) => s.features.files_touched === 1);
    expect(small.length).toBe(6);
    expect(small.every((s) => s.tercile === 1)).toBe(true);
  });

  test("features match the session's commit", () => {
    const s = sessions.find((x) => tagOf.get(x.id) === "X")!;
    const f = features(s, join(root, "confound"), NO_GRAPH);
    expect(f.files_touched).toBe(3);
    expect(f.first_prompt_len).toBe(s.first_prompt.length);
  });
});
