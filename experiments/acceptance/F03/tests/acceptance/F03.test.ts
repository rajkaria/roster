import { describe, test, expect } from "bun:test";
import { openPr } from "../../src/act/open-pr.ts";

type RunResult = { code: number; stdout: string; stderr: string };

function createRun(origin: string, ghResult?: RunResult) {
  const calls: string[][] = [];
  const run = async (cmd: string[]): Promise<RunResult> => {
    calls.push(cmd);
    if (cmd[0] === "git") {
      return { code: 0, stdout: origin, stderr: "" };
    }
    if (cmd[0] === "gh") {
      return ghResult ?? { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command: ${cmd.join(" ")}`);
  };
  return { run, calls };
}

describe("F03 openPr acceptance", () => {
  test("parses https remote and returns dry-run gh command without running it", async () => {
    const { run, calls } = createRun("https://github.com/acme/widget.git");
    let ownerRepoArg: string | undefined;
    const allowRepo = (ownerRepo: string) => {
      ownerRepoArg = ownerRepo;
      return true;
    };

    const result = await openPr({
      repoPath: "/tmp/widget",
      branch: "feature/thing",
      title: "Add thing",
      body: "This is the body",
      dryRun: true,
      allowRepo,
      run,
    });

    expect(ownerRepoArg).toBe("acme/widget");
    expect(result.command).toEqual([
      "gh",
      "pr",
      "create",
      "--head",
      "feature/thing",
      "--title",
      "Add thing",
      "--body-file",
      "This is the body",
    ]);
    expect(calls.filter((cmd) => cmd[0] === "gh")).toHaveLength(0);
  });

  test("allowRepo false returns not opted in and runs no gh command", async () => {
    const { run, calls } = createRun("https://github.com/acme/widget.git");
    let ownerRepoArg: string | undefined;
    const allowRepo = (ownerRepo: string) => {
      ownerRepoArg = ownerRepo;
      return false;
    };

    const result = await openPr({
      repoPath: "/tmp/widget",
      branch: "feature/thing",
      title: "Add thing",
      body: "This is the body",
      dryRun: false,
      allowRepo,
      run,
    });

    expect(ownerRepoArg).toBe("acme/widget");
    expect(result.opened).toBe(false);
    expect(result.reason).toBe("not opted in");
    expect(calls.filter((cmd) => cmd[0] === "gh")).toHaveLength(0);
  });

  test("parses ssh scp-like remote and returns url from stdout", async () => {
    const { run, calls } = createRun("git@github.com:acme/widget.git", {
      code: 0,
      stdout: "https://github.com/acme/widget/pull/42\n",
      stderr: "",
    });
    let ownerRepoArg: string | undefined;
    const allowRepo = (ownerRepo: string) => {
      ownerRepoArg = ownerRepo;
      return true;
    };

    const result = await openPr({
      repoPath: "/tmp/widget",
      branch: "feature/thing",
      title: "Add thing",
      body: "This is the body",
      dryRun: false,
      allowRepo,
      run,
    });

    expect(ownerRepoArg).toBe("acme/widget");
    expect(result.opened).toBe(true);
    expect(result.url).toBe("https://github.com/acme/widget/pull/42");
    expect(calls.some((cmd) => cmd[0] === "gh")).toBe(true);
  });

  test("parses ssh:// remote and returns url from stdout", async () => {
    const { run } = createRun("ssh://git@github.com/acme/widget.git", {
      code: 0,
      stdout: "https://github.com/acme/widget/pull/7",
      stderr: "",
    });
    const allowRepo = (ownerRepo: string) => ownerRepo === "acme/widget";

    const result = await openPr({
      repoPath: "/tmp/widget",
      branch: "feature/thing",
      title: "Add thing",
      body: "body",
      dryRun: false,
      allowRepo,
      run,
    });

    expect(result.opened).toBe(true);
    expect(result.url).toBe("https://github.com/acme/widget/pull/7");
  });

  test("non-zero gh exit returns stderr as reason", async () => {
    const { run } = createRun("https://github.com/acme/widget.git", {
      code: 1,
      stdout: "",
      stderr: "PR creation failed",
    });
    const allowRepo = () => true;

    const result = await openPr({
      repoPath: "/tmp/widget",
      branch: "feature/thing",
      title: "Add thing",
      body: "body",
      dryRun: false,
      allowRepo,
      run,
    });

    expect(result.opened).toBe(false);
    expect(result.reason).toBe("PR creation failed");
  });
});
