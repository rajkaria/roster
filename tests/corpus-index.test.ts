import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCorpusIndex, writeCorpusIndex } from "../scripts/corpus-index";
import { sumcheck } from "../scripts/sumcheck";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const setup = (sessions: number, spend: number | null) => ({ setup_id: `s${sessions}`, sessions, spend_usd: spend });

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "corpus-index-"));
  dirs.push(root);
  const put = (dir: string, review: unknown) => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "review.json"), JSON.stringify(review));
  };
  put("acme__alpha", { repo: "acme/alpha", suspect: null, setups: [setup(3, 1.5), setup(2, 2.25)] });
  put("acme__beta", { repo: "acme/beta", suspect: "s9", setups: [setup(10, null), setup(1, 4)] });
  put("acme__empty", { repo: "acme/empty", suspect: null, setups: [] });
  put("rajkaria__roster", { repo: "rajkaria/roster", suspect: null, setups: [setup(99, 99)] });
  put("_sample", { repo: "_sample/_sample", suspect: null, setups: [setup(77, 77)] });
  mkdirSync(join(root, "corpus"), { recursive: true });
  return root;
}

test("rows map each review, excluding our own repo and _sample", () => {
  const { data } = buildCorpusIndex(fixture(), "2026-10-12T00:00:00.000Z");
  expect(data.rows.map((r) => r.repo)).toEqual(["acme/beta", "acme/alpha", "acme/empty"]);
  expect(data.rows[0]).toEqual({ repo: "acme/beta", sessions: 11, setups: 2, costUsd: 4, suspect: "s9", replayed: 0, promoted: null });
  expect(data.rows[2]!.costUsd).toBeNull();
});

test("totals equal the row sums", () => {
  const { data } = buildCorpusIndex(fixture(), "t");
  expect(data.totals.repos).toBe(data.rows.length);
  expect(data.totals.sessions).toBe(data.rows.reduce((s, r) => s + r.sessions, 0));
  expect(data.totals.sessions).toBe(16);
  expect(data.totals.costUsd).toBeCloseTo(7.75, 9);
  expect(data.totals.replayed).toBe(0);
  expect(data.totals.promotions).toBe(0);
});

test("writes corpus/index.json with schemaVersion and passes sumcheck", () => {
  const root = fixture();
  const out = writeCorpusIndex(root, "2026-10-12T00:00:00.000Z");
  expect(out).toBe(join(root, "corpus", "index.json"));
  const written = JSON.parse(readFileSync(out, "utf8"));
  expect(written.schemaVersion).toBe(1);
  expect(written.generatedAt).toBe("2026-10-12T00:00:00.000Z");
  expect(written.data.totals.repos).toBe(3);
  expect(sumcheck(root).mismatches).toEqual([]);
});

test("re-running ignores the index it wrote earlier", () => {
  const root = fixture();
  writeCorpusIndex(root, "a");
  expect(buildCorpusIndex(root, "b").data.rows).toHaveLength(3);
});
