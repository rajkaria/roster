import { expect, test } from "bun:test";
import { runInMicroVm } from "../../../src/sandbox/microvm.ts";

type ExecResult = { code: number; stdout: string; stderr: string };

function makeClient(
  execImpl?: (cmd: string[], callIndex: number) => ExecResult | Promise<ExecResult>
) {
  const events: Array<{
    kind: "create" | "write" | "exec" | "stop";
    path?: string;
    content?: string;
    cmd?: string[];
    timeoutMs?: number;
  }> = [];
  const state = { createCalls: 0, stopCalls: 0 };

  return {
    events,
    state,
    async create(): Promise<{ id: string }> {
      state.createCalls += 1;
      events.push({ kind: "create" });
      return { id: "vm-1" };
    },
    async write(_id: string, path: string, content: string): Promise<void> {
      events.push({ kind: "write", path, content });
    },
    async exec(_id: string, cmd: string[], timeoutMs: number): Promise<ExecResult> {
      events.push({ kind: "exec", cmd: [...cmd], timeoutMs });
      const callIndex = events.filter((e) => e.kind === "exec").length;
      if (execImpl) return execImpl(cmd, callIndex);
      return { code: 0, stdout: "", stderr: "" };
    },
    async stop(_id: string): Promise<void> {
      state.stopCalls += 1;
      events.push({ kind: "stop" });
    },
  };
}

test("rejects non-https repo URLs before creating anything", async () => {
  const client = makeClient();

  await expect(
    runInMicroVm(
      {
        repoUrl: "git@github.com:owner/repo.git",
        command: ["true"],
        timeoutMs: 5000,
        files: { "README.md": "hi" },
      },
      client
    )
  ).rejects.toThrow();

  expect(client.state.createCalls).toBe(0);
  expect(client.state.stopCalls).toBe(0);
  expect(client.events).toEqual([]);
});

test("creates VM, writes files, clones, runs command, and stops", async () => {
  const client = makeClient((_cmd, callIndex) => {
    if (callIndex === 1) return { code: 0, stdout: "clone ok", stderr: "" };
    return { code: 0, stdout: "command out", stderr: "" };
  });

  const result = await runInMicroVm(
    {
      repoUrl: "https://github.com/owner/repo.git",
      command: ["pwd"],
      timeoutMs: 10000,
      files: { "README.md": "hello", "src/main.ts": "console.log('hi')" },
    },
    client
  );

  expect(result).toEqual({ code: 0, stdout: "command out", stderr: "", timedOut: false });
  expect(client.state.createCalls).toBe(1);
  expect(client.state.stopCalls).toBe(1);
  expect(client.events.map((e) => e.kind)).toEqual(["create", "write", "write", "exec", "exec", "stop"]);

  const execEvents = client.events.filter((e) => e.kind === "exec");
  expect(execEvents).toHaveLength(2);
  expect(execEvents[0]?.cmd).toEqual(["git", "clone", "--filter=blob:none", "https://github.com/owner/repo.git", "/work"]);
  expect(execEvents[0]?.timeoutMs).toBe(10000);
  expect(execEvents[1]?.timeoutMs).toBe(10000);
  expect(execEvents[1]?.cmd?.join(" ")).toContain("pwd");

  const writeEvents = client.events.filter((e) => e.kind === "write");
  expect(writeEvents).toEqual([
    { kind: "write", path: "README.md", content: "hello" },
    { kind: "write", path: "src/main.ts", content: "console.log('hi')" },
  ]);
});

test("does not write files when none are provided", async () => {
  const client = makeClient();

  await runInMicroVm(
    {
      repoUrl: "https://github.com/owner/repo.git",
      command: ["ls"],
      timeoutMs: 5000,
    },
    client
  );

  expect(client.events.map((e) => e.kind)).toEqual(["create", "exec", "exec", "stop"]);
  expect(client.events.filter((e) => e.kind === "write")).toEqual([]);
});

test("returns clone failure, does not run the command, and still stops", async () => {
  const client = makeClient((_cmd, callIndex) => {
    if (callIndex === 1) return { code: 128, stdout: "", stderr: "fatal clone" };
    return { code: 0, stdout: "should not run", stderr: "" };
  });

  const result = await runInMicroVm(
    {
      repoUrl: "https://github.com/owner/repo.git",
      command: ["false"],
      timeoutMs: 5000,
    },
    client
  );

  expect(result).toEqual({ code: 128, stdout: "", stderr: "fatal clone", timedOut: false });
  expect(client.state.stopCalls).toBe(1);
  expect(client.events.map((e) => e.kind)).toEqual(["create", "exec", "stop"]);
});

test("returns command failure and still stops", async () => {
  const client = makeClient((_cmd, callIndex) => {
    if (callIndex === 1) return { code: 0, stdout: "clone ok", stderr: "" };
    return { code: 1, stdout: "out", stderr: "boom" };
  });

  const result = await runInMicroVm(
    {
      repoUrl: "https://github.com/owner/repo.git",
      command: ["false"],
      timeoutMs: 5000,
    },
    client
  );

  expect(result).toEqual({ code: 1, stdout: "out", stderr: "boom", timedOut: false });
  expect(client.state.stopCalls).toBe(1);
  expect(client.events.map((e) => e.kind)).toEqual(["create", "exec", "exec", "stop"]);
});

test("returns timedOut true and code 124 on command timeout, and still stops", async () => {
  const client = makeClient((_cmd, callIndex) => {
    if (callIndex === 1) return { code: 0, stdout: "clone ok", stderr: "" };
    return { code: 124, stdout: "out", stderr: "timed out" };
  });

  const result = await runInMicroVm(
    {
      repoUrl: "https://github.com/owner/repo.git",
      command: ["sleep", "10"],
      timeoutMs: 100,
    },
    client
  );

  expect(result).toEqual({ code: 124, stdout: "out", stderr: "timed out", timedOut: true });
  expect(client.state.stopCalls).toBe(1);
  expect(client.events.map((e) => e.kind)).toEqual(["create", "exec", "exec", "stop"]);
});

test("returns timedOut true and code 124 on clone timeout, and still stops", async () => {
  const client = makeClient(() => ({ code: 124, stdout: "", stderr: "timeout" }));

  const result = await runInMicroVm(
    {
      repoUrl: "https://github.com/owner/repo.git",
      command: ["true"],
      timeoutMs: 100,
    },
    client
  );

  expect(result).toEqual({ code: 124, stdout: "", stderr: "timeout", timedOut: true });
  expect(client.state.stopCalls).toBe(1);
  expect(client.events.map((e) => e.kind)).toEqual(["create", "exec", "stop"]);
});

test("calls stop when an exec call rejects", async () => {
  const client = makeClient(async (_cmd, callIndex) => {
    if (callIndex === 1) return { code: 0, stdout: "clone ok", stderr: "" };
    throw new Error("vm exploded");
  });

  await expect(
    runInMicroVm(
      {
        repoUrl: "https://github.com/owner/repo.git",
        command: ["false"],
        timeoutMs: 5000,
      },
      client
    )
  ).rejects.toThrow("vm exploded");

  expect(client.state.stopCalls).toBe(1);
  expect(client.events.map((e) => e.kind)).toEqual(["create", "exec", "exec", "stop"]);
});
