import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandbox, destroySandbox, proveIsolation } from "../src/sandbox/index.ts";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

let tmp: string;
let source: string;
let shas: string[] = [];

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "roster-sandbox-test-"));
  source = join(tmp, "source");
  mkdirSync(source);
  git(source, "init", "-q");
  for (let i = 1; i <= 6; i++) {
    writeFileSync(join(source, `file${i}.txt`), `content of file ${i}\n${"x".repeat(i)}\n`);
    writeFileSync(join(source, "shared.txt"), `shared revision ${i}\n`);
    git(source, "add", "-A");
    git(source, "-c", "commit.gpgsign=false", "commit", "-q", "-m", `commit ${i}`);
    shas.push(git(source, "rev-parse", "HEAD"));
  }
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("sandbox", () => {
  test("sandbox at commit 3 of 6 has the tree and passes isolation", async () => {
    const root = join(tmp, "sandboxes");
    const sb = await createSandbox(source, shas[2]!, { root });
    expect(sb.path.startsWith(root)).toBe(true);
    expect(existsSync(join(sb.path, "file3.txt"))).toBe(true);
    expect(existsSync(join(sb.path, "file4.txt"))).toBe(false);
    expect(readFileSync(join(sb.path, "shared.txt"), "utf8")).toBe("shared revision 3\n");
    expect(git(sb.path, "rev-parse", "HEAD")).toBe(sb.baseSha);
    expect(git(sb.path, "log", "--all", "--format=%an %aI")).toBe("Roster 2000-01-01T00:00:00Z");

    const proof = await proveIsolation(sb.path, source, shas[2]!);
    expect(proof.checks.length).toBeGreaterThanOrEqual(3);
    expect(proof.checks.filter((c) => !c.ok)).toEqual([]);
    expect(proof.ok).toBe(true);

    await destroySandbox(sb.path);
    expect(existsSync(sb.path)).toBe(false);
  });

  test("a leaky copy (cp -r of .git) fails isolation", async () => {
    const leaky = join(tmp, "leaky");
    mkdirSync(leaky);
    Bun.spawnSync(["cp", "-R", join(source, ".git"), join(leaky, ".git")]);
    git(leaky, "checkout", "-q", "-f", shas[2]!);
    const proof = await proveIsolation(leaky, source, shas[2]!);
    expect(proof.ok).toBe(false);
    expect(proof.checks.some((c) => !c.ok)).toBe(true);
  });

  test("a sandbox with a remote fails isolation", async () => {
    const sb = await createSandbox(source, shas[2]!, { root: join(tmp, "sandboxes") });
    git(sb.path, "remote", "add", "origin", source);
    const proof = await proveIsolation(sb.path, source, shas[2]!);
    expect(proof.ok).toBe(false);
    await destroySandbox(sb.path);
  });
});
