import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeEnv } from "../src/forward/index.ts";

// A clean machine: no global or system git config, and no identity guessed from the OS account.
const CLEAN = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "user.useConfigOnly",
  GIT_CONFIG_VALUE_0: "true",
};

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "merge-identity-"));
  Bun.spawnSync(["git", "init", "-q", dir], { env: CLEAN });
  return dir;
}

test("with no configured identity the merge commits as Roster", () => {
  const dir = repo();
  const env = mergeEnv(dir, CLEAN);
  expect(env.GIT_COMMITTER_NAME).toBe("Roster");
  expect(env.GIT_COMMITTER_EMAIL).toBe("roster@example.invalid");
  expect(env.GIT_EDITOR).toBe("true");
  const commit = Bun.spawnSync(["git", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: dir, env });
  expect(commit.exitCode).toBe(0);
});

test("a configured identity is left alone", () => {
  const dir = repo();
  Bun.spawnSync(["git", "config", "user.name", "Operator"], { cwd: dir, env: CLEAN });
  Bun.spawnSync(["git", "config", "user.email", "op@example.invalid"], { cwd: dir, env: CLEAN });
  const env = mergeEnv(dir, CLEAN);
  expect(env.GIT_COMMITTER_NAME).toBeUndefined();
  expect(env.GIT_COMMITTER_EMAIL).toBeUndefined();
});

test("identity already in the environment wins over the fallback", () => {
  const env = mergeEnv(repo(), { ...CLEAN, GIT_COMMITTER_NAME: "CI", GIT_COMMITTER_EMAIL: "ci@example.invalid" });
  expect(env.GIT_COMMITTER_NAME).toBe("CI");
  expect(env.GIT_COMMITTER_EMAIL).toBe("ci@example.invalid");
});
