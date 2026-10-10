import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, makeFixture, SETUPS } from "./fixtures/make-fixture";
import { parseCheckpoints } from "../src/ingest/parse";
import { identify, inferenceAccuracy, parseTag, setupIdOf, type IdentitySource } from "../src/identity";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

let dir: string;

const initRepo = (repo: string) => {
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
};
const writeRepoFile = (repo: string, rel: string, text: string) => {
  mkdirSync(join(repo, rel, ".."), { recursive: true });
  writeFileSync(join(repo, rel), text);
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "roster-identity-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseTag", () => {
  test("reads the tag at the start of the first prompt", () => {
    expect(parseTag("[roster setup=A task=T04] Build the identity module.")).toEqual({ setup: "A", task: "T04" });
  });

  test("tolerates leading whitespace", () => {
    expect(parseTag("  [roster setup=D task=T12]\nGo.")).toEqual({ setup: "D", task: "T12" });
  });

  test("returns null when there is no tag or the tag is not at the start", () => {
    expect(parseTag("Build the identity module.")).toBeNull();
    expect(parseTag("Please use [roster setup=A task=T04] for this.")).toBeNull();
    expect(parseTag("")).toBeNull();
  });
});

describe("identify on a fixture with three setups", () => {
  // Real-shaped checkpoints built by the shared fixture builder: three setups, two harnesses,
  // rules hashed from the transcript attachments (Claude) or the AGENTS.md world state (Codex).
  let repo: string;
  let truth: ReturnType<typeof makeFixture>;
  let sessions: ReturnType<typeof parseCheckpoints>;
  let setupOf: Map<string, string>;

  beforeAll(() => {
    repo = join(dir, "three-setups");
    truth = makeFixture(repo, "basic");
    sessions = parseCheckpoints(repo, "auto");
    setupOf = new Map(truth.checkpoints.flatMap((c) => c.sessions.map((s) => [s.session_id, s.setup] as const)));
  });

  test("three setups give three setup ids", () => {
    const ids = new Set(sessions.map((s) => identify(s, repo).setupId));
    expect(ids.size).toBe(3);
    expect(ids.has(null)).toBe(false);
  });

  test("each session's setup id matches its ground-truth setup", () => {
    const byTruth = new Map<string, Set<string | null>>();
    for (const s of sessions) {
      const letter = setupOf.get(s.id)!;
      byTruth.set(letter, (byTruth.get(letter) ?? new Set()).add(identify(s, repo).setupId));
    }
    expect([...byTruth.keys()].sort()).toEqual(["X", "Y", "Z"]);
    for (const ids of byTruth.values()) expect(ids.size).toBe(1);
  });

  test("harness, model and rules hash agree with the fixture's ground truth", () => {
    for (const s of sessions) {
      const id = identify(s, repo);
      const expected = SETUPS[setupOf.get(s.id) as keyof typeof SETUPS];
      const truthSetup = truth.setups[setupOf.get(s.id) as keyof typeof truth.setups];
      expect(id.harness).toBe(expected.agent === "Claude Code" ? "claude-code" : "codex");
      expect(id.model).toBe(truthSetup.model);
      expect(id.rulesHash).toBe(truthSetup.rules_hash);
      expect(id.rulesPath).toBe(truthSetup.rules_path);
    }
  });

  test("tags in the prompts match the ground-truth setups", () => {
    for (const s of sessions) {
      expect(identify(s, repo).tag?.setup).toBe(setupOf.get(s.id)!);
    }
  });

  test("inference is 1:1 with the tags", () => {
    const identified = sessions.map((s) => identify(s, repo));
    expect(inferenceAccuracy(identified)).toBe(1);
  });
});

describe("rules change mid-history", () => {
  // Plain-text rules files in a scratch repo. Transcripts record no rules here, so the hash
  // comes from the file at each session's parent commit.
  let repo: string;
  let commits: string[];
  const v1 = "# Rules v1\n\n- Write tests.\n";
  const v2 = "# Rules v2\n\n- Write tests.\n- Keep diffs small.\n";

  beforeAll(() => {
    repo = join(dir, "rules-change");
    initRepo(repo);
    const commit = (msg: string, edits: Record<string, string>) => {
      for (const [path, text] of Object.entries(edits)) writeRepoFile(repo, path, text);
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "--no-gpg-sign", "-m", msg]);
      return git(repo, ["rev-parse", "HEAD"]);
    };
    commits = [
      commit("init", { "CLAUDE.md": v1, "src/a.ts": "export const a = 1;\n" }),
      commit("add b", { "src/b.ts": "export const b = 2;\n" }),
      commit("tighten rules", { "CLAUDE.md": v2 }),
      commit("add c", { "src/c.ts": "export const c = 3;\n" }),
    ];
  });

  const session = (commit: string | null, prompt = "[roster setup=A task=T04] Do it."): IdentitySource => ({
    harness: "Claude Code",
    model: "claude-opus-5-5",
    rules_hash: null,
    commit_sha: commit,
    first_prompt: prompt,
  });

  test("the hash is the normalised rules file at the parent commit", () => {
    const id = identify(session(commits[1]!), repo);
    expect(id.rulesHash).toBe(sha256(v1.trim()));
    expect(id.rulesPath).toBe("CLAUDE.md");
  });

  test("a session after the rules change gets a new setup id", () => {
    const before = identify(session(commits[1]!), repo).setupId;
    const same = identify(session(commits[2]!), repo).setupId;
    const after = identify(session(commits[3]!), repo);
    expect(before).not.toBeNull();
    expect(same).toBe(before);
    expect(after.rulesHash).toBe(sha256(v2.trim()));
    expect(after.setupId).not.toBe(before);
    expect(after.setupId).toBe(setupIdOf("claude-code", "claude-opus-5-5", sha256(v2.trim())));
  });

  test("a transcript hash takes precedence over the parent-commit fallback", () => {
    const fromTranscript = "f".repeat(64);
    const id = identify({ ...session(commits[3]!), rules_hash: fromTranscript }, repo);
    expect(id.rulesHash).toBe(fromTranscript);
    expect(id.rulesPath).toBe("CLAUDE.md");
  });
});

describe("unknown inputs stay null", () => {
  let repo: string;
  let root: string;

  beforeAll(() => {
    repo = join(dir, "unknown");
    initRepo(repo);
    writeRepoFile(repo, "CLAUDE.md", "# Rules\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "--no-gpg-sign", "-m", "init"]);
    root = git(repo, ["rev-parse", "HEAD"]);
  });

  test("a harness with no known rules file gets null rules and null setup", () => {
    const id = identify(
      { harness: "Copilot CLI", model: "unknown", rules_hash: null, commit_sha: root, first_prompt: "Hi" },
      repo,
    );
    expect(id).toEqual({ setupId: null, harness: "copilot-cli", model: "unknown", rulesHash: null, rulesPath: null, tag: null });
  });

  test("a root commit has no parent, so its rules are unknown", () => {
    const id = identify({ harness: "Claude Code", model: "claude-sonnet-5-5", rules_hash: null, commit_sha: root, first_prompt: "Hi" }, repo);
    expect(id.setupId).toBeNull();
    expect(id.rulesHash).toBeNull();
  });

  test("a session with no linked commit has no fallback", () => {
    const id = identify({ harness: "Codex", model: "gpt-6-astra", rules_hash: null, commit_sha: null, first_prompt: "Hi" }, repo);
    expect(id.setupId).toBeNull();
    expect(id.rulesHash).toBeNull();
    expect(id.model).toBe("gpt-6-astra");
  });
});

describe("inferenceAccuracy", () => {
  const row = (setupId: string | null, setup: string | null) => ({
    setupId,
    tag: setup === null ? null : { setup, task: "T04" },
  });

  test("null when no session is tagged", () => {
    expect(inferenceAccuracy([row("s1", null), row(null, null)])).toBeNull();
    expect(inferenceAccuracy([])).toBeNull();
  });

  test("1 when every tagged session maps 1:1", () => {
    expect(inferenceAccuracy([row("s1", "A"), row("s1", "A"), row("s2", "B"), row("s3", "C")])).toBe(1);
  });

  test("untagged sessions are excluded from the share", () => {
    expect(inferenceAccuracy([row("s1", "A"), row("s2", "B"), row("s9", null)])).toBe(1);
  });

  test("a stray session in a cluster is counted as the only mismatch", () => {
    const rows = [...Array(9)].map(() => row("s1", "A")).concat([row("s2", "A")]);
    expect(inferenceAccuracy(rows)).toBe(0.9);
  });

  test("two tags merged into one setup id are both wrong", () => {
    expect(inferenceAccuracy([row("s1", "A"), row("s1", "B")])).toBe(0);
  });

  test("a session with no inferred setup is wrong", () => {
    expect(inferenceAccuracy([row("s1", "A"), row(null, "B")])).toBe(0.5);
  });
});
