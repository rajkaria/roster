import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./fixtures/make-fixture";
import { identify, setupIdOf, type IdentitySource } from "../src/identity";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const NO_RULES = sha256("no-rules-file");

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "roster-identity-norules-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// A Pi repo whose history has no rules file until a later commit adds AGENTS.md.
// Commit 0 is the root (no parent), commit 1 and 2 have no rules at their parent, commit 3 does.
describe("sessions with no rules recorded anywhere", () => {
  let repo: string;
  let commits: string[];
  const agents = "# Agents\n\n- Keep diffs small.\n";

  beforeAll(() => {
    repo = join(dir, "no-rules");
    mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-q", "-b", "main"]);
    const commit = (msg: string, edits: Record<string, string>) => {
      for (const [path, text] of Object.entries(edits)) {
        mkdirSync(join(repo, path, ".."), { recursive: true });
        writeFileSync(join(repo, path), text);
      }
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "--no-gpg-sign", "-m", msg]);
      return git(repo, ["rev-parse", "HEAD"]);
    };
    commits = [
      commit("init", { "src/a.ts": "export const a = 1;\n" }),
      commit("add b", { "src/b.ts": "export const b = 2;\n" }),
      commit("add c", { "src/c.ts": "export const c = 3;\n" }),
      commit("add agents", { "AGENTS.md": agents }),
      commit("add d", { "src/d.ts": "export const d = 4;\n" }),
    ].map((sha) => sha.trim());
  });

  const pi = (commit: string | null, model = "pi-model-1", prompt = "Fix the bug."): IdentitySource => ({
    harness: "Pi",
    model,
    rules_hash: null,
    commit_sha: commit,
    first_prompt: prompt,
  });

  test("a parent with no rules file gets the no-rules sentinel, not null", () => {
    const id = identify(pi(commits[2]!), repo);
    expect(id.setupId).not.toBeNull();
    expect(id.rulesHash).toBe(NO_RULES);
    expect(id.rulesPath).toBe("(none)");
    expect(id.setupId).toBe(setupIdOf("pi", "pi-model-1", NO_RULES));
  });

  test("two Pi sessions with no rules share a setup id", () => {
    const first = identify(pi(commits[1]!), repo).setupId;
    const second = identify(pi(commits[2]!), repo).setupId;
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  test("adding an AGENTS.md at the parent changes the id", () => {
    const before = identify(pi(commits[2]!), repo);
    const after = identify(pi(commits[4]!), repo);
    expect(after.rulesPath).toBe("AGENTS.md");
    expect(after.rulesHash).toBe(sha256(agents.trim()));
    expect(after.setupId).not.toBe(before.setupId);
  });

  test("the rules fallback works for any harness, not only the ones with a rules file", () => {
    const id = identify({ ...pi(commits[4]!), harness: "Copilot CLI" }, repo);
    expect(id.harness).toBe("copilot-cli");
    expect(id.rulesPath).toBe("AGENTS.md");
    expect(id.setupId).not.toBeNull();
  });

  test("an empty model groups under unknown-model, not under a null id", () => {
    const empty = identify(pi(commits[2]!, ""), repo);
    expect(empty.setupId).toBe(setupIdOf("pi", "unknown-model", NO_RULES));
    expect(empty.setupId).toBe(identify(pi(commits[1]!, ""), repo).setupId);
  });

  test("a session with no linked commit and no transcript rules keeps a null setup id", () => {
    const id = identify(pi(null), repo);
    expect(id.setupId).toBeNull();
    expect(id.rulesHash).toBeNull();
    expect(id.rulesPath).toBeNull();
  });

  test("a root commit has no parent, so its rules stay unknown", () => {
    const id = identify(pi(commits[0]!), repo);
    expect(id.setupId).toBeNull();
    expect(id.rulesHash).toBeNull();
  });

  test("a transcript that records no rules still takes the parent fallback, not the sentinel", () => {
    const id = identify({ ...pi(commits[4]!), rules_hash: null }, repo);
    expect(id.rulesHash).toBe(sha256(agents.trim()));
  });
});
