import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECKPOINT_BRANCH, SAMPLES_DIR, git, makeFixture, type FixtureTruth, type Scenario } from "./fixtures/make-fixture.ts";
import { EVIDENCE_LEVELS, FailureCode } from "../src/types.ts";

const sample = (name: string) => readFileSync(join(SAMPLES_DIR, name), "utf8");
const sampleKeys = (name: string) => Object.keys(JSON.parse(sample(name))).sort();
const keys = (o: object) => Object.keys(o).sort();

/** Sample file → its name inside a checkpoint's session dir `<n>/`. */
const SESSION_FILES = {
  "session-metadata-claude-code.json": "metadata.json",
  "claude-code-full.jsonl": "full.jsonl",
  "content_hash.txt": "content_hash.txt",
  "prompt.txt": "prompt.txt",
};

// Building a fixture spawns git a few hundred times; confound takes seconds.
setDefaultTimeout(30_000);

const root = mkdtempSync(join(tmpdir(), "roster-fx-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function build(scenario: Scenario, name: string = scenario) {
  const dir = join(root, name);
  return { dir, truth: makeFixture(dir, scenario) };
}

describe("src/types.ts enums", () => {
  test("FailureCode is F1..F7 and EvidenceLevel is A|B|C", () => {
    expect(Object.values(FailureCode) as string[]).toEqual(["F1", "F2", "F3", "F4", "F5", "F6", "F7"]);
    expect([...EVIDENCE_LEVELS]).toEqual(["A", "B", "C"]);
  });
});

describe("make-fixture --scenario basic", () => {
  let dir: string;
  let truth: FixtureTruth;
  const show = (path: string) => git(dir, ["show", `${CHECKPOINT_BRANCH}:${path}`]);
  beforeAll(() => {
    ({ dir, truth } = build("basic"));
  });

  test("CLI creates the repo", () => {
    const out = join(root, "cli");
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "fixtures/make-fixture.ts"), out, "--scenario", "basic"]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.toString()).head).toBe(git(out, ["rev-parse", "HEAD"]));
  });

  test("12 commits, 4 Entire-Checkpoint trailers, 1 revert", () => {
    const log = git(dir, ["log", "main", "--format=%H%x00%B%x01"]).split("\x01").map((s) => s.trim()).filter(Boolean);
    expect(log.length).toBe(12);
    const trailers = log.flatMap((c) => [...c.matchAll(/^Entire-Checkpoint: ([0-9a-f]{12})$/gm)].map((m) => m[1]));
    expect(trailers.length).toBe(4);
    expect(log.filter((c) => /^This reverts commit [0-9a-f]{40}/m.test(c)).length).toBe(1);
  });

  test("branch layout matches the samples: <id[0:2]>/<id[2:]>/ with the sample file names", () => {
    const paths = git(dir, ["ls-tree", "-r", "--name-only", CHECKPOINT_BRANCH]).split("\n");
    const ids = new Set(paths.map((p) => p.split("/").slice(0, 2).join("")));
    expect(ids.size).toBe(4);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{12}$/);
      const base = `${id.slice(0, 2)}/${id.slice(2)}`;
      const mine = paths.filter((p) => p.startsWith(base + "/")).map((p) => p.slice(base.length + 1));
      expect(mine).toContain("metadata.json");
      const sessionDirs = [...new Set(mine.filter((p) => p.includes("/")).map((p) => p.split("/")[0]))];
      for (const n of sessionDirs) {
        const files = mine.filter((p) => p.startsWith(`${n}/`)).map((p) => p.slice(n!.length + 1)).sort();
        expect(files).toEqual(Object.values(SESSION_FILES).sort());
      }
    }
  });

  test("root metadata.json has the sample's top-level keys and repo-absolute session paths", () => {
    const want = sampleKeys("branch-root-metadata.json");
    const sampleEntry = keys(JSON.parse(sample("branch-root-metadata.json")).sessions[0]);
    for (const cp of truth.checkpoints) {
      const base = `${cp.id.slice(0, 2)}/${cp.id.slice(2)}`;
      const meta = JSON.parse(show(`${base}/metadata.json`));
      expect(keys(meta)).toEqual(want);
      expect(keys(meta.token_usage)).toEqual(keys(JSON.parse(sample("branch-root-metadata.json")).token_usage));
      expect(meta.checkpoint_id).toBe(cp.id);
      expect(meta.sessions.length).toBe(cp.sessions.length);
      for (const entry of meta.sessions) {
        expect(keys(entry)).toEqual(sampleEntry);
        for (const p of Object.values(entry) as string[]) {
          expect(p.startsWith(`/${base}/`)).toBe(true);
          expect(() => show(p.slice(1))).not.toThrow();
        }
      }
    }
  });

  test("session metadata.json and transcripts have the sample keys for their agent", () => {
    const claudeLines = sample("claude-code-full.jsonl").trim().split("\n").map((l) => JSON.parse(l));
    const codexLines = sample("codex-full.jsonl").trim().split("\n").map((l) => JSON.parse(l));
    let codex = 0;
    for (const cp of truth.checkpoints) {
      for (const s of cp.sessions) {
        const dirPath = `${cp.id.slice(0, 2)}/${cp.id.slice(2)}/${s.index}`;
        const meta = JSON.parse(show(`${dirPath}/metadata.json`));
        const isCodex = meta.agent === "Codex";
        codex += isCodex ? 1 : 0;
        expect(keys(meta)).toEqual(sampleKeys(isCodex ? "session-metadata-codex.json" : "session-metadata-claude-code.json"));
        expect(meta.session_id).toBe(s.session_id);
        expect(meta.checkpoint_id).toBe(cp.id);
        const full = show(`${dirPath}/full.jsonl`) + "\n";
        const lines = full.trim().split("\n").map((l) => JSON.parse(l));
        const shapes = isCodex ? codexLines : claudeLines;
        for (const line of lines) {
          const shape = shapes.find((x) => x.type === line.type && (x.attachment?.type ?? null) === (line.attachment?.type ?? null));
          expect(shape).toBeDefined();
          expect(keys(line)).toEqual(keys(shape));
        }
        expect(show(`${dirPath}/content_hash.txt`)).toBe(`sha256:${createHash("sha256").update(full).digest("hex")}`);
        const prompt = show(`${dirPath}/prompt.txt`);
        expect(prompt.split("\n\n---\n\n")[0]).toMatch(new RegExp(`^\\[roster setup=${s.setup} task=`));
      }
    }
    expect(codex).toBeGreaterThan(0);
  });

  test("every trailer resolves to a checkpoint on the branch", () => {
    for (const c of truth.commits.filter((c) => c.checkpoint_id)) {
      const body = git(dir, ["log", "-1", "--format=%B", c.sha]);
      expect(body).toContain(`Entire-Checkpoint: ${c.checkpoint_id}`);
      const id = c.checkpoint_id!;
      expect(JSON.parse(show(`${id.slice(0, 2)}/${id.slice(2)}/metadata.json`)).checkpoint_id).toBe(id);
    }
  });

  test("one human commit without a trailer reworks agent-added lines", () => {
    const rework = truth.commits.filter((c) => c.kind === "rework");
    expect(rework.length).toBe(1);
    const r = rework[0]!;
    expect(git(dir, ["log", "-1", "--format=%B", r.sha])).not.toContain("Entire-Checkpoint");
    const target = truth.commits.find((c) => c.sha === r.target_sha)!;
    expect(target.checkpoint_id).not.toBeNull();
    const reworkedFile = git(dir, ["diff", "--name-only", `${r.sha}^`, r.sha]);
    expect(git(dir, ["diff", "--name-only", `${target.sha}^`, target.sha]).split("\n")).toContain(reworkedFile);
    const removed = git(dir, ["diff", "-U0", `${r.sha}^`, r.sha]).split("\n").filter((l) => /^-[^-]/.test(l));
    expect(removed.length).toBeGreaterThan(0);
  });

  test("one checkpoint holds two sessions, and a session recurs across checkpoints", () => {
    expect(truth.checkpoints.filter((c) => c.sessions.length === 2).length).toBe(1);
    const ids = truth.checkpoints.flatMap((c) => c.sessions.map((s) => s.session_id));
    expect(new Set(ids).size).toBeLessThan(ids.length);
  });

  test("three setups differ by model and rules file", () => {
    const s = Object.values(truth.setups);
    expect(s.length).toBe(3);
    expect(new Set(s.map((x) => x.model)).size).toBe(3);
    expect(new Set(s.map((x) => x.rules_hash)).size).toBe(3);
  });

  test("deterministic: rebuilding gives identical commit ids", () => {
    const again = build("basic", "basic-again").truth;
    expect(again.head).toBe(truth.head);
    expect(again.checkpoint_branch_head).toBe(truth.checkpoint_branch_head);
  });
});

describe("other scenarios", () => {
  test("confound: setup X gets only the large changes", () => {
    const { truth } = build("confound");
    const filesBy = (setup: string) =>
      truth.checkpoints.filter((c) => c.sessions[0]!.setup === setup).map((c) => c.files.length);
    expect(filesBy("X").every((n) => n === 3)).toBe(true);
    for (const other of ["Y", "Z"]) {
      expect(new Set(filesBy(other))).toEqual(new Set([1, 2, 3]));
    }
    expect(truth.commits.filter((c) => c.kind === "revert").length).toBeGreaterThan(1);
  });

  test("revert: adds a ≥50% deletion without a revert message", () => {
    const { dir, truth } = build("revert");
    const del = truth.commits.find((c) => c.kind === "delete")!;
    const stat = git(dir, ["diff", "--numstat", `${del.sha}^`, del.sha]).split("\t");
    const target = truth.commits.find((c) => c.sha === del.target_sha)!;
    const added = Number(git(dir, ["diff", "--numstat", `${target.sha}^`, target.sha]).split("\t")[0]);
    expect(Number(stat[1]) / added).toBeGreaterThanOrEqual(0.5);
    expect(git(dir, ["log", "-1", "--format=%B", del.sha])).not.toContain("This reverts");
  });

  test("multisession: three-session checkpoint and a checkpoint with no commit", () => {
    const { truth } = build("multisession");
    expect(truth.checkpoints.some((c) => c.sessions.length === 3)).toBe(true);
    expect(truth.checkpoints.filter((c) => c.commit_sha === null).length).toBe(1);
  });
});
