import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { claudeRulesHash, setupIdOf } from "../src/identity";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// Row shapes follow tests/fixtures/samples/claude-code-full.jsonl (`attachment.type:"instructions"`,
// `files[].{path,type,content}`); the cwd is recorded on the conversation rows.
type File = { path: string; type: string; content: string };
const instructions = (...files: File[]) => ({ type: "attachment", attachment: { type: "instructions", files } });
const nested = (...files: File[]) => ({ type: "attachment", attachment: { type: "nested_memory", files } });
const withCwd = (cwd: string, ...rows: object[]) => [{ type: "user", cwd }, ...rows];

const RULES = "# Example project rules\n";
const LOCAL = "# Private rules\n";
const idOf = (rows: object[]) => setupIdOf("claude-code", "claude-opus-5-5", claudeRulesHash(rows));

describe("rules hash covers every loaded rules file", () => {
  test("same CLAUDE.md in two worktrees gives the same id", () => {
    const a = withCwd("/work/wt-a", instructions({ path: "/work/wt-a/CLAUDE.md", type: "Project", content: RULES }));
    const b = withCwd("/other/wt-b", instructions({ path: "/other/wt-b/CLAUDE.md", type: "Project", content: RULES }));
    expect(idOf(a)).not.toBeNull();
    expect(idOf(a)).toBe(idOf(b));
  });

  test("a single CLAUDE.md hashes as its normalised text", () => {
    const rows = withCwd("/w", instructions({ path: "/w/CLAUDE.md", type: "Project", content: RULES }));
    expect(claudeRulesHash(rows)).toBe(sha256(RULES.trim()));
  });

  test("adding a CLAUDE.local.md attachment changes the id", () => {
    const base = instructions({ path: "/w/CLAUDE.md", type: "Project", content: RULES });
    const local = { path: "/w/CLAUDE.local.md", type: "Local", content: LOCAL };
    expect(idOf(withCwd("/w", instructions(base.attachment.files[0]!, local)))).not.toBe(idOf(withCwd("/w", base)));
  });

  test("a nested CLAUDE.md counts, and file order does not matter", () => {
    const root: File = { path: "/w/CLAUDE.md", type: "Project", content: RULES };
    const sub: File = { path: "/w/web/CLAUDE.md", type: "Project", content: "# web\n" };
    expect(idOf(withCwd("/w", instructions(root), nested(sub)))).not.toBe(idOf(withCwd("/w", instructions(root))));
    expect(idOf(withCwd("/w", instructions(sub, root)))).toBe(idOf(withCwd("/w", instructions(root, sub))));
  });

  test("User-type and out-of-repo files do not change the id", () => {
    const root: File = { path: "/w/CLAUDE.md", type: "Project", content: RULES };
    const base = idOf(withCwd("/w", instructions(root)));
    const user: File = { path: "/Users/me/.claude/CLAUDE.md", type: "User", content: "# mine\n" };
    expect(idOf(withCwd("/w", instructions(root, user)))).toBe(base);
    const outside: File = { path: "/Users/me/.claude/rules.md", type: "Project", content: "# x\n" };
    expect(idOf(withCwd("/w", instructions(root, outside)))).toBe(base);
  });

  test("no repo rules means no hash", () => {
    const user: File = { path: "/Users/me/.claude/CLAUDE.md", type: "User", content: "# mine\n" };
    expect(claudeRulesHash(withCwd("/w", instructions(user)))).toBeNull();
    expect(claudeRulesHash([])).toBeNull();
  });
});
