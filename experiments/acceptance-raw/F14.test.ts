import { test, expect, mock } from "bun:test";
import { runActCommand } from "../../../src/cli/act.ts";

function createDeps(overrides: Partial<{
  readJson: (p: string) => Promise<unknown>;
  writeFile: (p: string, s: string) => Promise<void>;
  git: (args: string[]) => Promise<{ code: number; stdout: string }>;
  openPr: (o: unknown) => Promise<{ opened: boolean; url?: string; reason?: string }>;
  stdout: (s: string) => void;
}> = {}) {
  const readJson = mock(async (_: string) => ({}));
  const writeFile = mock(async (_: string, _s: string) => {});
  const git = mock(async (_: string[]) => ({ code: 0, stdout: "" }));
  const openPr = mock(async (_: unknown) => ({ opened: true }));
  const stdout = mock((_s: string) => {});

  const deps = {
    readJson,
    writeFile,
    git,
    openPr,
    stdout,
    ...overrides,
  };

  return { deps, readJson, writeFile, git, openPr, stdout };
}

const promoteSetup = {
  id: "setup-1",
  harness: "harness-a",
  model: "model-a",
  rules_hash: "abc123",
  rules_path: "rules/setup-1.txt",
  label: "candidate",
};

const promoteGate = {
  id: "decision-1",
  plan_id: "plan-1",
  candidate: "setup-1",
  verdict: "promote",
  reasons: ["good"],
  trace_url: null,
  setup: promoteSetup,
  rules: "candidate rules content",
};

test("non-promote decision prints nothing to act on and returns 0", async () => {
  const { deps, stdout, writeFile, git, openPr } = createDeps({
    readJson: async () => ({
      ...promoteGate,
      verdict: "reject",
    }),
  });

  const result = await runActCommand(["--gate", "gate.json"], deps as any);

  expect(result).toBe(0);
  const printed = (stdout as any).mock.calls.map((c: any) => c[0]).join("");
  expect(printed).toContain("nothing to act on");
  expect(writeFile).not.toHaveBeenCalled();
  expect(git).not.toHaveBeenCalled();
  expect(openPr).not.toHaveBeenCalled();
});

test("promote decision writes setup and rules, creates branch, commits, and returns 0", async () => {
  const { deps, readJson, writeFile, git, openPr } = createDeps({
    readJson: async () => promoteGate,
  });

  const result = await runActCommand(["--gate", "gate.json"], deps as any);

  expect(result).toBe(0);

  expect(writeFile).toHaveBeenCalledWith(
    "setups/setup-1.json",
    expect.stringContaining("setup-1"),
  );
  expect(writeFile).toHaveBeenCalledWith(
    "rules/setup-1.txt",
    "candidate rules content",
  );

  const gitCalls = (git as any).mock.calls.map((c: any) => c[0] as string[]);
  expect(gitCalls.some((args) => args.includes("roster/promote-setup-1"))).toBe(true);
  expect(
    gitCalls.some(
      (args) =>
        args[0] === "commit" &&
        args.includes("roster: promote setup setup-1"),
    ),
  ).toBe(true);

  expect(openPr).not.toHaveBeenCalled();
});

test("promote decision with --pr calls openPr", async () => {
  const { deps, readJson, openPr } = createDeps({
    readJson: async () => promoteGate,
  });

  const result = await runActCommand(
    ["--gate", "gate.json", "--pr"],
    deps as any,
  );

  expect(result).toBe(0);
  expect(openPr).toHaveBeenCalledTimes(1);
});

test("promote decision with --pr --dry-run passes dryRun through to openPr", async () => {
  const { deps, readJson, openPr } = createDeps({
    readJson: async () => promoteGate,
  });

  await runActCommand(
    ["--gate", "gate.json", "--pr", "--dry-run"],
    deps as any,
  );

  expect(openPr).toHaveBeenCalledTimes(1);
  const prArg = (openPr as any).mock.calls[0][0] as Record<string, unknown>;
  expect(prArg?.dryRun).toBe(true);
});

test("returns 1 when a git step fails", async () => {
  const { deps, readJson, git } = createDeps({
    readJson: async () => promoteGate,
    git: async (_: string[]) => ({ code: 1, stdout: "fatal" }),
  });

  const result = await runActCommand(["--gate", "gate.json"], deps as any);

  expect(result).toBe(1);
  expect(git).toHaveBeenCalled();
});
