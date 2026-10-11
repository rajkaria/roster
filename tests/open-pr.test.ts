// F03: opening a PR safely. Unit tests drive openPr through an injected runner; the two last tests exercise the
// real spawner against a throwaway git repo, so the owner/repo lookup is covered end to end without touching gh.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPr, parsePrUrl, prCreateCommand, type RunResult, type Runner } from "../src/act/open-pr.ts";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};

/** The acceptance-test fake: answers git and gh, records every argv, and refuses anything else. */
function fakeRun(origin: string | RunResult, gh?: RunResult, throwOnGh = false) {
  const calls: string[][] = [];
  const run: Runner = async (cmd) => {
    calls.push(cmd);
    if (cmd[0] === "git") {
      return typeof origin === "string" ? { code: 0, stdout: origin, stderr: "" } : origin;
    }
    if (cmd[0] === "gh") {
      if (throwOnGh) throw new Error("gh is not installed");
      return gh ?? { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command: ${cmd.join(" ")}`);
  };
  const ghCalls = () => calls.filter((cmd) => cmd[0] === "gh");
  return { run, calls, ghCalls };
}

const body = "This is the body";
const expectedCommand = [
  "gh",
  "pr",
  "create",
  "--head",
  "feature/thing",
  "--title",
  "Add thing",
  "--body-file",
  "This is the body",
];

function base(overrides: Partial<Parameters<typeof openPr>[0]> = {}) {
  return {
    repoPath: "/tmp/widget",
    branch: "feature/thing",
    title: "Add thing",
    body,
    allowRepo: () => true,
    ...overrides,
  };
}

describe("openPr", () => {
  test("dry run parses the https remote, returns the command and runs no gh", async () => {
    const { run, ghCalls } = fakeRun("https://github.com/acme/widget.git");
    const seen: string[] = [];

    const result = await openPr(base({ dryRun: true, run, allowRepo: (o) => (seen.push(o), true) }));

    expect(seen).toEqual(["acme/widget"]);
    expect(result.command).toEqual(expectedCommand);
    expect(result.opened).toBe(false);
    expect(ghCalls()).toEqual([]);
  });

  test("a repo that is not opted in never runs gh", async () => {
    const { run, ghCalls } = fakeRun("https://github.com/acme/widget.git");
    const seen: string[] = [];

    const result = await openPr(base({ run, allowRepo: (o) => (seen.push(o), false) }));

    expect(seen).toEqual(["acme/widget"]);
    expect(result.opened).toBe(false);
    expect(result.reason).toBe("not opted in");
    expect(result.command).toEqual([]);
    expect(ghCalls()).toEqual([]);
  });

  test("scp-style ssh remote opens the PR and returns the url", async () => {
    const { run, ghCalls } = fakeRun("git@github.com:acme/widget.git", {
      code: 0,
      stdout: "https://github.com/acme/widget/pull/42\n",
      stderr: "",
    });

    const result = await openPr(base({ run }));

    expect(result.opened).toBe(true);
    expect(result.url).toBe("https://github.com/acme/widget/pull/42");
    expect(ghCalls()).toEqual([expectedCommand]);
  });

  test("ssh:// remote with a user and a port resolves to owner/repo", async () => {
    const { run } = fakeRun("ssh://git@github.com:2222/acme/widget.git", {
      code: 0,
      stdout: "https://github.com/acme/widget/pull/7",
      stderr: "",
    });
    const seen: string[] = [];

    const result = await openPr(base({ run, allowRepo: (o) => (seen.push(o), true) }));

    expect(seen).toEqual(["acme/widget"]);
    expect(result.opened).toBe(true);
    expect(result.url).toBe("https://github.com/acme/widget/pull/7");
  });

  test("a warning line before the url does not hide it", async () => {
    const { run } = fakeRun("https://github.com/acme/widget", {
      code: 0,
      stdout: "Warning: 3 uncommitted changes\nCreating pull request for feature/thing into main\nhttps://github.com/acme/widget/pull/9\n",
      stderr: "",
    });

    const result = await openPr(base({ run }));

    expect(result.url).toBe("https://github.com/acme/widget/pull/9");
  });

  test("non-zero gh exit reports the trimmed stderr and no url", async () => {
    const { run } = fakeRun("https://github.com/acme/widget.git", {
      code: 1,
      stdout: "",
      stderr: "PR creation failed\n",
    });

    const result = await openPr(base({ run }));

    expect(result.opened).toBe(false);
    expect(result.reason).toBe("PR creation failed");
    expect(result.url).toBeUndefined();
    expect(result.command).toEqual(expectedCommand);
  });

  test("gh exit 0 with no url is opened without a url", async () => {
    const { run } = fakeRun("https://github.com/acme/widget.git", { code: 0, stdout: "", stderr: "" });

    const result = await openPr(base({ run }));

    expect(result.opened).toBe(true);
    expect(result.url).toBeUndefined();
  });

  test("a gh call that throws becomes a failed result, not a throw", async () => {
    const { run } = fakeRun("https://github.com/acme/widget.git", undefined, true);

    const result = await openPr(base({ run }));

    expect(result.opened).toBe(false);
    expect(result.reason).toBe("gh is not installed");
  });

  test("an origin remote that cannot be read stops before gh", async () => {
    const { run, ghCalls } = fakeRun({ code: 128, stdout: "", stderr: "error: No such remote 'origin'\n" });

    const result = await openPr(base({ run }));

    expect(result.opened).toBe(false);
    expect(result.reason).toBe("error: No such remote 'origin'");
    expect(result.command).toEqual([]);
    expect(ghCalls()).toEqual([]);
  });

  test("an origin remote that is not an owner/repo url stops before gh", async () => {
    const { run, ghCalls } = fakeRun("/srv/git/widget.git\n");

    const result = await openPr(base({ run }));

    expect(result.opened).toBe(false);
    expect(result.reason).toContain("origin has no owner/name");
    expect(result.command).toEqual([]);
    expect(ghCalls()).toEqual([]);
  });
});

describe("helpers", () => {
  test("prCreateCommand is the pinned argv", () => {
    expect(prCreateCommand({ branch: "b", title: "t", body: "y" })).toEqual([
      "gh",
      "pr",
      "create",
      "--head",
      "b",
      "--title",
      "t",
      "--body-file",
      "y",
    ]);
  });

  test("parsePrUrl takes the last url token and strips trailing punctuation", () => {
    expect(parsePrUrl("")).toBeNull();
    expect(parsePrUrl("no url here")).toBeNull();
    expect(parsePrUrl("https://github.com/a/b/pull/1\n")).toBe("https://github.com/a/b/pull/1");
    expect(parsePrUrl("see (https://github.com/a/b/pull/2).\n")).toBe("https://github.com/a/b/pull/2");
  });
});

describe("openPr with the real runner", () => {
  const tmp = mkdtempSync(join(tmpdir(), "roster-open-pr-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  function repoWithRemote(name: string, remote?: string): string {
    const dir = join(tmp, name);
    const init = Bun.spawnSync(["git", "init", "-q", "-b", "main", dir], { env: GIT_ENV });
    if (init.exitCode !== 0) throw new Error(init.stderr.toString());
    if (remote !== undefined) {
      const add = Bun.spawnSync(["git", "remote", "add", "origin", remote], { cwd: dir, env: GIT_ENV });
      if (add.exitCode !== 0) throw new Error(add.stderr.toString());
    }
    return dir;
  }

  test("reads owner/repo from a real repo and runs no gh in dry-run", async () => {
    const dir = repoWithRemote("with-remote", "https://github.com/acme/widget.git");
    const seen: string[] = [];

    const result = await openPr(base({ repoPath: dir, dryRun: true, allowRepo: (o) => (seen.push(o), true) }));

    expect(seen).toEqual(["acme/widget"]);
    expect(result.command).toEqual(expectedCommand);
    expect(result.opened).toBe(false);
  });

  test("a repo with no origin reports git's own words as the reason", async () => {
    const dir = repoWithRemote("no-remote");

    const result = await openPr(base({ repoPath: dir }));

    expect(result.opened).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.reason?.toLowerCase()).toContain("origin");
    expect(result.command).toEqual([]);
  });
});
