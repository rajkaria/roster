import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseCheckpoints } from "../src/ingest/parse";

const SAMPLES = join(import.meta.dir, "fixtures", "samples");
const sample = (f: string) => readFileSync(join(SAMPLES, f), "utf8");
const sampleJson = (f: string) => JSON.parse(sample(f));
const sampleRows = sample("claude-code-full.jsonl").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// shapes copied from the sample transcript: its instructions attachment and its assistant row
const instructionsRow = sampleRows.find((r) => r.attachment?.type === "instructions");
const assistantRow = sampleRows.find((r) => r.type === "assistant");
const [P1] = sample("prompt.txt").split("\n\n---\n\n").map((s) => s.trim());

const file = (path: string, type: string, content: string) => ({ path, type, content });
const instructions = (...files: object[]) => ({ ...instructionsRow, attachment: { ...instructionsRow.attachment, files } });
const nested = (f: { path: string }) => ({ type: "attachment", attachment: { type: "nested_memory", path: f.path, content: f } });
const user = (content: unknown, extra: object = {}) => ({ type: "user", message: { role: "user", content }, ...extra });
const withCwd = (cwd: string, rows: object[]) => rows.map((r) => ({ cwd, ...r }));

let repo: string;
let n = 0;

function git(...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
}

function put(rel: string, content: string) {
  const full = join(repo, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** Adds one single-session checkpoint; returns its session id. */
function session(rows: object[], promptTxt?: string): string {
  n++;
  const id = String(n).padStart(12, "0");
  const sid = `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;
  const dir = `${id.slice(0, 2)}/${id.slice(2)}`;
  put(`${dir}/metadata.json`, JSON.stringify({ ...sampleJson("branch-root-metadata.json"), checkpoint_id: id }));
  put(`${dir}/0/metadata.json`, JSON.stringify({ ...sampleJson("session-metadata-claude-code.json"), checkpoint_id: id, session_id: sid, created_at: "2026-03-25T10:00:00Z" }));
  put(`${dir}/0/full.jsonl`, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  if (promptTxt !== undefined) put(`${dir}/0/prompt.txt`, promptTxt);
  return sid;
}

const CLAUDE_MD = file("/work/a/CLAUDE.md", "Project", "# rules\n");
const LOCAL_MD = file("/work/a/CLAUDE.local.md", "Local", "# my local rules\n");
const USER_MD = file("/Users/x/.claude/CLAUDE.md", "User", "# personal\n");

const ids: Record<string, string> = {};

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "roster-parse-pr-"));
  git("init", "-q", "-b", "main");
  put("README.md", "x\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  git("checkout", "-q", "--orphan", "entire/checkpoints/v1");
  git("rm", "-rfq", ".");

  const injected = [
    user("do the thing"),
    user([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]),
    user("<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>"),
    user([{ type: "text", text: "<system-reminder>\nremember\n</system-reminder>" }]),
    user("summary of earlier turns", { isCompactSummary: true }),
    user("meta text", { isMeta: true }),
    assistantRow,
    user("now the second thing"),
  ];
  ids.transcriptOnly = session(injected);
  ids.promptTxt = session(injected, P1);

  ids.base = session(withCwd("/work/a", [instructions(CLAUDE_MD), assistantRow]));
  ids.local = session(withCwd("/work/a", [instructions(CLAUDE_MD, LOCAL_MD), assistantRow]));
  ids.localNested = session(withCwd("/work/a", [instructions(CLAUDE_MD), nested(LOCAL_MD), assistantRow]));
  ids.userFile = session(withCwd("/work/a", [instructions(CLAUDE_MD, USER_MD), assistantRow]));
  ids.userNested = session(withCwd("/work/a", [instructions(CLAUDE_MD), nested(USER_MD), assistantRow]));
  ids.otherTree = session(
    withCwd("/work/b", [
      instructions(file("/work/b/CLAUDE.md", "Project", "# rules\n"), file("/work/b/CLAUDE.local.md", "Local", "# my local rules\n")),
      assistantRow,
    ]),
  );

  git("add", ".");
  git("commit", "-q", "-m", "checkpoints");
  git("checkout", "-q", "main");
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("parse: prompts and rules_hash", () => {
  let sessions: ReturnType<typeof parseCheckpoints>;
  beforeAll(() => {
    sessions = parseCheckpoints(repo, "branch", { warn: () => {} });
  });
  const get = (k: string) => sessions.find((s) => s.id === ids[k])!;

  test("tool results, notifications, reminders, meta and compact summaries don't count", () => {
    expect(get("transcriptOnly").n_user_prompts).toBe(2);
    expect(get("transcriptOnly").first_prompt).toBe("do the thing");
  });

  test("prompt.txt with 1 prompt gives 1, whatever the transcript holds", () => {
    expect(get("promptTxt").n_user_prompts).toBe(1);
  });

  test("a Local CLAUDE.local.md attachment changes rules_hash", () => {
    expect(get("base").rules_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(get("local").rules_hash).not.toBe(get("base").rules_hash);
    expect(get("localNested").rules_hash).toBe(get("local").rules_hash);
  });

  test("a User-type file doesn't change rules_hash", () => {
    expect(get("userFile").rules_hash).toBe(get("base").rules_hash);
    expect(get("userNested").rules_hash).toBe(get("base").rules_hash);
  });

  test("same files in two worktree paths hash the same", () => {
    expect(get("otherTree").rules_hash).toBe(get("local").rules_hash);
  });
});
