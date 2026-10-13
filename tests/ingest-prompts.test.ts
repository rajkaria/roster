import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseCheckpoints, unionPrompts } from "../src/ingest/parse";

const SAMPLES = join(import.meta.dir, "fixtures", "samples");
const sample = (f: string) => readFileSync(join(SAMPLES, f), "utf8");
const sampleJson = (f: string) => JSON.parse(sample(f));

const SID_SAME = "aaaaaaaa-0000-0000-0000-000000000000";
const SID_GROW = "bbbbbbbb-0000-0000-0000-000000000000";

// the sample prompt.txt holds two prompts; its first stands in for a one-prompt session
const [P1, P2] = sample("prompt.txt").split("\n\n---\n\n").map((s) => s.trim());

let repo: string;

function git(...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

function put(rel: string, content: string) {
  const full = join(repo, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function checkpoint(id: string, sid: string, created: string, prompt: string) {
  const dir = `${id.slice(0, 2)}/${id.slice(2)}`;
  put(`${dir}/metadata.json`, JSON.stringify({ ...sampleJson("branch-root-metadata.json"), checkpoint_id: id }));
  put(`${dir}/0/metadata.json`, JSON.stringify({ ...sampleJson("session-metadata-claude-code.json"), checkpoint_id: id, session_id: sid, created_at: created }));
  put(`${dir}/0/full.jsonl`, sample("claude-code-full.jsonl"));
  put(`${dir}/0/prompt.txt`, prompt);
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "roster-prompts-"));
  git("init", "-q", "-b", "main");
  put("README.md", "x\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  git("checkout", "-q", "--orphan", "entire/checkpoints/v1");
  git("rm", "-rfq", ".");

  // one prompt, three commits: every checkpoint repeats the same prompt (whitespace differs in the last)
  checkpoint("111111111111", SID_SAME, "2026-03-25T10:00:00Z", P1!);
  checkpoint("222222222222", SID_SAME, "2026-03-25T11:00:00Z", P1!);
  checkpoint("333333333333", SID_SAME, "2026-03-25T12:00:00Z", `  ${P1!.replace(/ /g, "  ")}\n`);

  // the second checkpoint carries the first prompt again plus a new one
  checkpoint("444444444444", SID_GROW, "2026-03-26T10:00:00Z", P1!);
  checkpoint("555555555555", SID_GROW, "2026-03-26T11:00:00Z", `${P1}\n\n---\n\n${P2}`);

  git("add", ".");
  git("commit", "-q", "-m", "checkpoints");
  git("checkout", "-q", "main");
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("n_user_prompts across checkpoints", () => {
  let sessions: ReturnType<typeof parseCheckpoints>;
  beforeAll(() => {
    sessions = parseCheckpoints(repo, "branch", { warn: () => {} });
  });
  const get = (id: string) => sessions.find((s) => s.id === id)!;
  const tu = sampleJson("session-metadata-claude-code.json").token_usage;

  // These checkpoints carry no checkpoint_transcript_start, so each token_usage covers the session from its start:
  // a running total. The session's tokens are the latest one, never the sum (post-deadline fix, 13 Oct).
  test("one prompt repeated in 3 checkpoints counts once; tokens are the latest running total, not a sum", () => {
    expect(get(SID_SAME)).toMatchObject({
      n_user_prompts: 1,
      first_prompt: P1,
      checkpoint_id: "111111111111",
      tokens_in: tu.input_tokens,
      tokens_out: tu.output_tokens,
      cache_read: tu.cache_read_tokens,
      cache_write: tu.cache_creation_tokens,
    });
  });

  test("a later checkpoint adding a new prompt counts 2; tokens are the latest running total", () => {
    expect(get(SID_GROW)).toMatchObject({
      n_user_prompts: 2,
      first_prompt: P1,
      tokens_in: tu.input_tokens,
      tokens_out: tu.output_tokens,
    });
  });
});

describe("unionPrompts", () => {
  test("keeps first-occurrence order of distinct normalised prompts", () => {
    expect(unionPrompts([[P1!], [P1!, P2!], [` ${P2}`, P1!]])).toEqual([P1!, P2!]);
  });

  test("a prompt typed twice within one slice stays two prompts, and is not added again later", () => {
    expect(unionPrompts([[P2!, P1!, P2!], [P2!, P1!, P2!]])).toEqual([P2!, P1!, P2!]);
    expect(unionPrompts([[P2!], [P2!, P1!, P2!]])).toEqual([P2!, P1!, P2!]);
  });

  test("no slices or empty slices give no prompts", () => {
    expect(unionPrompts([])).toEqual([]);
    expect(unionPrompts([[], []])).toEqual([]);
  });
});
