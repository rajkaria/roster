import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPrompt, check, currentState, merged, readCheckpoint, readLedger, record, sync, type Ctx } from "../scripts/ledger.ts";

// Checkpoint payloads are clones of the redacted real samples with ids and prompts overridden.
const SAMPLES = join(import.meta.dir, "fixtures", "samples");
const sample = (n: string) => readFileSync(join(SAMPLES, n), "utf8");

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};

function git(cwd: string, args: string[], opts: { input?: string; env?: Record<string, string> } = {}): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...GIT_ENV, ...opts.env }, stdin: opts.input !== undefined ? Buffer.from(opts.input) : undefined });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

let tmp: string;
let repo: string;
let n = 0;

function commit(msg: string, file = `f${++n}.txt`) {
  writeFileSync(join(repo, file), `${n}\n`);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", msg]);
}

/** Write a checkpoint tree (one session dir per entry) and return its tree sha. */
function checkpointTree(id: string, sessions: { session_id: string; created_at: string; prompts: string[] }[]): string {
  const dir = join(tmp, `cp-${id}`);
  const root = JSON.parse(sample("branch-root-metadata.json"));
  root.checkpoint_id = id;
  root.sessions = sessions.map((_, i) => ({ metadata: `${i}/metadata.json`, prompt: `${i}/prompt.txt` }));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "metadata.json"), JSON.stringify(root, null, 2));
  sessions.forEach((s, i) => {
    const meta = JSON.parse(sample("session-metadata-claude-code.json"));
    Object.assign(meta, { checkpoint_id: id, session_id: s.session_id, created_at: s.created_at });
    mkdirSync(join(dir, String(i)), { recursive: true });
    writeFileSync(join(dir, String(i), "metadata.json"), JSON.stringify(meta, null, 2));
    writeFileSync(join(dir, String(i), "prompt.txt"), s.prompts.join("\n\n---\n\n"));
  });
  const env = { GIT_INDEX_FILE: join(tmp, `idx-${id}`), GIT_WORK_TREE: dir };
  git(repo, ["add", "-A", "."], { env });
  return git(repo, ["write-tree"], { env });
}

/** Refs backend: one ref per checkpoint, message carries the sample's trailers. */
function refsCheckpoint(id: string, session_id: string, prompts: string[], created_at = "2026-10-10T10:00:00Z") {
  const tree = checkpointTree(id, [{ session_id, created_at, prompts }]);
  const msg = sample("refs-commit-message.txt")
    .replace(/^Checkpoint: .*$/m, `Checkpoint: ${id}`)
    .replace(/^Entire-Session: .*$/m, `Entire-Session: ${session_id}`)
    .replace(/^Entire-Strategy: .*$/m, "Entire-Strategy: manual-commit");
  const c = git(repo, ["commit-tree", tree], { input: msg });
  git(repo, ["update-ref", `refs/entire/checkpoints/${id.slice(-2)}/${id}`, c]);
}

/** Branch backend: cumulative tree on entire/checkpoints/v1 at <id[0:2]>/<id[2:]>/. */
function branchCheckpoint(id: string, session_id: string, prompts: string[], created_at = "2026-10-10T11:00:00Z") {
  const tree = checkpointTree(id, [{ session_id, created_at, prompts }]);
  const inner = git(repo, ["mktree"], { input: `040000 tree ${tree}\t${id.slice(2)}\n` });
  const outer = git(repo, ["mktree"], { input: `040000 tree ${inner}\t${id.slice(0, 2)}\n` });
  const c = git(repo, ["commit-tree", outer], { input: "Checkpoint branch\n" });
  git(repo, ["update-ref", "refs/heads/entire/checkpoints/v1", c]);
}

function mergeNoFf(branch: string): string {
  git(repo, ["checkout", "-q", "main"]);
  git(repo, ["-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", `Merge ${branch}`, branch]);
  return git(repo, ["rev-parse", "HEAD"]);
}

const ctx = (): Ctx => ({ repo, ledger: join(tmp, "reports", "self", "tasks.jsonl"), base: "main" });

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "roster-ledger-test-"));
  repo = join(tmp, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  commit("initial");

  // T01: setup A, tagged A, 2 checkpoints (refs + branch backend), one human fix commit.
  git(repo, ["checkout", "-q", "-b", "task/T01"]);
  refsCheckpoint("01HZZZZZZZZZZZZZZZZZZZZZA1", "s-t01", ["[roster setup=A task=T01]\n\ndo T01", "yes"]);
  commit("T01: first\n\nEntire-Checkpoint: 01HZZZZZZZZZZZZZZZZZZZZZA1");
  branchCheckpoint("0a1b2c3d4e5f", "s-t01", ["[roster setup=A task=T01]\n\ndo T01", "yes", "now tests"]);
  commit("T01: second\n\nEntire-Checkpoint: 0a1b2c3d4e5f");
  commit("human: fix typo");

  // T02: recorded as setup B, but the session's prompt tag says setup C.
  git(repo, ["checkout", "-q", "main"]);
  git(repo, ["checkout", "-q", "-b", "task/T02"]);
  refsCheckpoint("01HZZZZZZZZZZZZZZZZZZZZZB2", "s-t02", ["[roster setup=C task=T02]\n\ndo T02"]);
  commit("T02: work\n\nEntire-Checkpoint: 01HZZZZZZZZZZZZZZZZZZZZZB2");

  // T03: merged without any checkpoint trailer.
  git(repo, ["checkout", "-q", "main"]);
  git(repo, ["checkout", "-q", "-b", "task/T03"]);
  commit("T03: untracked work");

  // T04: recorded, still open (unmerged); synced from branch minus main.
  git(repo, ["checkout", "-q", "main"]);
  git(repo, ["checkout", "-q", "-b", "task/T04"]);
  refsCheckpoint("01HZZZZZZZZZZZZZZZZZZZZZD4", "s-t04", ["[roster setup=D task=T04]\n\ngo"]);
  commit("T04: wip\n\nEntire-Checkpoint: 01HZZZZZZZZZZZZZZZZZZZZZD4");
  git(repo, ["checkout", "-q", "main"]);
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("buildPrompt", () => {
  test("mirrors run-setup.sh: tag, guardrails, rest of block", () => {
    const tasks = "intro\n<!-- T09 -->\n[roster setup=B task=T09]\nTASK T09\nbody\n\n<!-- /T09 -->\n";
    expect(buildPrompt(tasks, "T09", "RULES\n\n")).toBe("[roster setup=B task=T09]\n\nRULES\n\nTASK T09\nbody");
    expect(buildPrompt(tasks, "T10", "RULES")).toBeNull();
  });
});

describe("ledger on a temp git repo", () => {
  test("record stores prompt hash and tag from ROSTER_TASKS", () => {
    const tasksFile = join(tmp, "tasks.md");
    writeFileSync(tasksFile, "<!-- T01 -->\n[roster setup=A task=T01]\nTASK T01\n<!-- /T01 -->\n");
    const e = record({ ...ctx(), tasksFile }, "T01", "A", "task/T01");
    expect(e.prompt_tag).toBe("[roster setup=A task=T01]");
    expect(e.prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(e.merge_sha).toBeNull();
    for (const [t, s] of [["T02", "B"], ["T03", "A"], ["T04", "D"]] as const) record(ctx(), t, s, `task/${t}`);
  });

  test("merged stores the full merge sha; unknown task throws", () => {
    for (const t of ["T01", "T02", "T03"]) {
      const sha = mergeNoFf(`task/${t}`);
      expect(merged(ctx(), t, sha.slice(0, 10)).merge_sha).toBe(sha);
    }
    expect(() => merged(ctx(), "T99", "HEAD")).toThrow();
  });

  test("sync fills checkpoints, sessions, prompts and human commits from trailers", () => {
    const state = new Map(sync(ctx()).map((e) => [e.task, e]));
    const t1 = state.get("T01")!;
    expect(t1.checkpoint_ids).toEqual(["01HZZZZZZZZZZZZZZZZZZZZZA1", "0a1b2c3d4e5f"]);
    expect(t1.session_ids).toEqual(["s-t01"]);
    expect(t1.user_prompts).toBe(3); // cumulative prompt.txt across checkpoints, not double-counted
    expect(t1.human_commits).toBe(1);
    expect(t1.prompt_tag).toBe("[roster setup=A task=T01]");
    expect(state.get("T02")!.prompt_tag).toBe("[roster setup=C task=T02]");
    expect(state.get("T03")!.checkpoint_ids).toEqual([]);
    expect(state.get("T04")!.checkpoint_ids).toEqual(["01HZZZZZZZZZZZZZZZZZZZZZD4"]);
    expect(state.get("T04")!.session_ids).toEqual(["s-t04"]);
  });

  test("readCheckpoint reads both backends; unknown id is null", () => {
    expect(readCheckpoint(repo, "01HZZZZZZZZZZZZZZZZZZZZZA1")?.map((s) => s.session_id)).toEqual(["s-t01"]);
    expect(readCheckpoint(repo, "0a1b2c3d4e5f")?.[0]?.prompts.length).toBe(3);
    expect(readCheckpoint(repo, "ffffffffffff")).toBeNull();
  });

  test("ledger is append-only and every line has the full schema", () => {
    const before = readFileSync(ctx().ledger, "utf8");
    sync(ctx()); // no change → nothing appended
    expect(readFileSync(ctx().ledger, "utf8")).toBe(before);
    const lines = readLedger(ctx().ledger);
    const keys = ["task", "setup", "branch", "started_at", "prompt_sha256", "merge_sha", "checkpoint_ids", "user_prompts", "human_commits"];
    for (const l of lines) for (const k of keys) expect(l).toHaveProperty(k);
    expect(lines.length).toBeGreaterThan(currentState(lines).length);
  });

  test("check flags tag/setup mismatch and missing checkpoints, ignores unmerged tasks", () => {
    const problems = check(ctx());
    expect(problems).toContainEqual(expect.objectContaining({ task: "T02", problem: "tag_setup_mismatch" }));
    expect(problems).toContainEqual(expect.objectContaining({ task: "T03", problem: "no_checkpoint" }));
    expect(problems.filter((p) => p.task === "T01" || p.task === "T04")).toEqual([]);
  });

  test("CLI: check exits 1 on problems, 2 on bad usage", () => {
    const run = (...args: string[]) =>
      Bun.spawnSync(["bun", join(import.meta.dir, "..", "scripts", "ledger.ts"), ...args], {
        cwd: repo,
        env: { ...GIT_ENV, ROSTER_LEDGER: ctx().ledger },
      });
    const r = run("check");
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout.toString()).merged_tasks).toBe(3);
    expect(r.stderr.toString()).toContain("T02 tag_setup_mismatch");
    expect(run("bogus").exitCode).toBe(2);
  });
});
