import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseCheckpoints } from "../src/ingest/parse";

const SAMPLES = join(import.meta.dir, "fixtures", "samples");
const sample = (f: string) => readFileSync(join(SAMPLES, f), "utf8");
const sampleJson = (f: string) => JSON.parse(sample(f));

const SID_CLAUDE = "ba40f717-0000-0000-0000-b57a4768e4c0";
const SID_CODEX = "01a07359-0000-0000-0000-000000000000";
const SID_LONE = "dddddddd-0000-0000-0000-000000000000";

let repo: string;
const warnings: string[] = [];

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

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "roster-parse-"));
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "https://github.com/acme/widgets.git");
  put("README.md", "x\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");

  const claudeMeta = sampleJson("session-metadata-claude-code.json");
  const codexMeta = sampleJson("session-metadata-codex.json");
  const root = sampleJson("branch-root-metadata.json");

  // Branch backend, built from the redacted samples.
  git("checkout", "-q", "--orphan", "entire/checkpoints/v1");
  git("rm", "-rfq", ".");

  // A: claude session; metadata has model + tokens; two prompts.
  put("02/674b7ab946/metadata.json", JSON.stringify(root));
  put("02/674b7ab946/0/metadata.json", JSON.stringify(claudeMeta));
  put("02/674b7ab946/0/full.jsonl", sample("claude-code-full.jsonl"));
  put("02/674b7ab946/0/prompt.txt", sample("prompt.txt"));

  // B: two sessions in one checkpoint. 0 = the same claude session again (empty model), as a slice that starts
  // mid-transcript (checkpoint_transcript_start), so its tokens add to A's; 1 = codex (no metadata tokens).
  const { token_usage: _drop, ...codexNoTokens } = codexMeta;
  put("aa/aaaaaaaaaa/metadata.json", JSON.stringify({ ...root, checkpoint_id: "aaaaaaaaaaaa" }));
  put(
    "aa/aaaaaaaaaa/0/metadata.json",
    JSON.stringify({
      ...claudeMeta,
      checkpoint_id: "aaaaaaaaaaaa",
      model: "",
      created_at: "2026-03-26T10:00:00Z",
      checkpoint_transcript_start: 120,
      files_touched: ["src/a.ts", ".entire/settings.json"],
      token_usage: { input_tokens: 5, cache_creation_tokens: 10, cache_read_tokens: 1000, output_tokens: 100, api_call_count: 1 },
    }),
  );
  put("aa/aaaaaaaaaa/0/full.jsonl", sample("claude-code-full.jsonl"));
  put("aa/aaaaaaaaaa/0/prompt.txt", "one more thing");
  put("aa/aaaaaaaaaa/1/metadata.json", JSON.stringify({ ...codexNoTokens, checkpoint_id: "aaaaaaaaaaaa" }));
  put("aa/aaaaaaaaaa/1/full.jsonl", sample("codex-full.jsonl"));
  put("aa/aaaaaaaaaa/1/prompt.txt", "codex prompt");

  // C: malformed JSON; must be skipped with a warning.
  put("cc/cccccccccc/metadata.json", "{ not json");
  put("cc/cccccccccc/0/metadata.json", "{ not json");

  // D: no metadata model or tokens, so the transcript is used. Has a subagent task and no commit.
  put("dd/dddddddddd/metadata.json", JSON.stringify({ ...root, checkpoint_id: "dddddddddddd" }));
  const { token_usage: _t, model: _m, ...lone } = claudeMeta;
  put(
    "dd/dddddddddd/0/metadata.json",
    JSON.stringify({ ...lone, checkpoint_id: "dddddddddddd", session_id: SID_LONE, created_at: "2026-03-27T10:00:00Z", files_touched: null }),
  );
  put("dd/dddddddddd/0/full.jsonl", sample("claude-code-full.jsonl"));
  put("dd/dddddddddd/tasks/toolu_1/task.json", "{}");
  put("dd/dddddddddd/tasks/toolu_1/agent-x.jsonl", sample("claude-code-full.jsonl").split("\n")[2] + "\n");

  git("add", ".");
  git("commit", "-q", "-m", "checkpoints");
  git("checkout", "-q", "main");

  // Commits carrying the trailers: one on main, one on another branch.
  put("a.txt", "a\n");
  git("add", ".");
  git("commit", "-q", "-m", "feat: a\n\nEntire-Checkpoint: 02674b7ab946");
  git("checkout", "-q", "-b", "feature");
  put("b.txt", "b\n");
  git("add", ".");
  git("commit", "-q", "-m", "feat: b\n\nEntire-Checkpoint: aaaaaaaaaaaa");
  git("checkout", "-q", "main");
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("parseCheckpoints (branch backend)", () => {
  let sessions: ReturnType<typeof parseCheckpoints>;
  beforeAll(() => {
    sessions = parseCheckpoints(repo, "branch", { warn: (m) => warnings.push(m) });
  });
  const get = (id: string) => sessions.find((s) => s.id === id)!;

  test("exact row count; malformed checkpoint skipped with a warning, others parsed", () => {
    expect(sessions.map((s) => s.id).sort()).toEqual([SID_CLAUDE, SID_CODEX, SID_LONE].sort());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("cccccccccccc");
  });

  test("session recurring across checkpoints is aggregated", () => {
    const s = get(SID_CLAUDE);
    expect(s).toMatchObject({
      repo: "acme/widgets",
      harness: "Claude Code",
      model: "claude-sonnet-4-6",
      model_source: "metadata",
      usage_source: "metadata",
      tokens_in: 20,
      tokens_out: 903,
      cache_read: 200160,
      cache_write: 18536,
      n_user_prompts: 3,
      first_prompt: "okay let's git stash the header changes, then switch to main and pull",
      checkpoint_id: "02674b7ab946",
      source: "branch",
      entire_url: `https://entire.io/gh/acme/widgets/session/${SID_CLAUDE}`,
    });
    expect(s.files).toEqual([".claude/settings.json", ".entire/settings.json", "src/a.ts"]);
    expect(s.rules_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("commit links come from trailers on any branch", () => {
    const main = git("rev-parse", "main");
    expect(get(SID_CLAUDE).commit_sha).toBe(main);
    const linkedB = get(SID_CODEX).commit_sha;
    expect(linkedB).toBe(git("rev-parse", "feature"));
    expect(linkedB).not.toBe(main);
  });

  test("multi-session checkpoint splits; tokens and model fall back to the transcript", () => {
    expect(get(SID_CODEX)).toMatchObject({
      harness: "Codex",
      model: "gpt-6-astra",
      model_source: "transcript",
      usage_source: "transcript",
      tokens_in: 743941 - 676480,
      tokens_out: 1899,
      cache_read: 676480,
      cache_write: 0,
      n_user_prompts: 1,
      cost_usd: null,
    });
  });

  test("session without a commit keeps commit_sha null; subagent usage attaches to parent", () => {
    const s = get(SID_LONE);
    expect(s.commit_sha).toBeNull();
    expect(s.model).toBe("claude-opus-5-5");
    expect(s.usage_source).toBe("transcript");
    // the transcript's assistant line plus the same line again as a subagent task
    expect(s.tokens_in).toBe(4);
    expect(s.tokens_out).toBe(4830);
    expect(s.cache_read).toBe(94992);
    expect(s.cache_write).toBe(8808);
    expect(s.files).toEqual([]);
  });
});

describe("parseCheckpoints (git-refs backend)", () => {
  test("reads the one-ref-per-checkpoint layout", () => {
    const id = "01HZXTESTULID000000000000A";
    const meta = sampleJson("session-metadata-claude-code.json");
    const files: Record<string, string> = {
      "metadata.json": JSON.stringify(sampleJson("branch-root-metadata.json")),
      "0/metadata.json": JSON.stringify({ ...meta, checkpoint_id: id, session_id: "refs-session" }),
      "0/full.jsonl": sample("claude-code-full.jsonl"),
    };
    const dir = mkdtempSync(join(tmpdir(), "roster-refs-"));
    for (const [k, v] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, k)), { recursive: true });
      writeFileSync(join(dir, k), v);
    }
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, ".idx"), GIT_WORK_TREE: dir };
    const run = (args: string[]) => {
      const p = Bun.spawnSync(["git", ...args], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
      if (p.exitCode !== 0) throw new Error(p.stderr.toString());
      return p.stdout.toString().trim();
    };
    run(["add", "-f", "metadata.json", "0"]);
    const tree = run(["write-tree"]);
    rmSync(dir, { recursive: true, force: true });

    const commit = git("commit-tree", tree, "-m", `Checkpoint: ${id}\n\nEntire-Session: refs-session\nEntire-Strategy: manual-commit\nEntire-Agent: Claude Code`);
    git("update-ref", `refs/entire/checkpoints/${id.slice(-2)}/${id}`, commit);

    const rows = parseCheckpoints(repo, "git-refs", { warn: () => {} });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "refs-session", checkpoint_id: id, source: "git-refs", commit_sha: null, model: "claude-sonnet-4-6" });
  });
});
