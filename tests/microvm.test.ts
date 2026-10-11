import { describe, expect, test } from "bun:test";
import {
  runInMicroVm,
  type MicroVmClient,
  type MicroVmExecResult,
  type MicroVmRunOptions,
} from "../src/sandbox/microvm.ts";

type Event =
  | { kind: "create" }
  | { kind: "write"; id: string; path: string; content: string }
  | { kind: "exec"; id: string; cmd: string[]; timeoutMs: number }
  | { kind: "stop"; id: string };

interface FakeHandlers {
  create?: () => Promise<{ id: string }>;
  exec?: (cmd: string[], call: number) => MicroVmExecResult | Promise<MicroVmExecResult>;
  stop?: () => Promise<void>;
}

/** A recording stand-in for the VM provider. No VM, and nothing runs on this host. */
function fakeVm(handlers: FakeHandlers = {}) {
  const events: Event[] = [];
  const client: MicroVmClient = {
    async create() {
      events.push({ kind: "create" });
      return handlers.create ? await handlers.create() : { id: "vm-1" };
    },
    async write(id, path, content) {
      events.push({ kind: "write", id, path, content });
    },
    async exec(id, cmd, timeoutMs) {
      events.push({ kind: "exec", id, cmd: [...cmd], timeoutMs });
      const call = events.filter((e) => e.kind === "exec").length;
      return handlers.exec ? await handlers.exec(cmd, call) : { code: 0, stdout: "", stderr: "" };
    },
    async stop(id) {
      events.push({ kind: "stop", id });
      if (handlers.stop) await handlers.stop();
    },
  };
  return {
    client,
    events,
    kinds: () => events.map((e) => e.kind),
    execs: () => events.filter((e) => e.kind === "exec"),
    writes: () => events.filter((e) => e.kind === "write"),
    stops: () => events.filter((e) => e.kind === "stop"),
  };
}

/** Clone succeeds, then the command returns `result`. */
function cloneThen(result: MicroVmExecResult): FakeHandlers {
  return {
    exec: (_cmd, call) => (call === 1 ? { code: 0, stdout: "clone ok", stderr: "" } : result),
  };
}

const OPTS: MicroVmRunOptions = {
  repoUrl: "https://github.com/owner/repo.git",
  command: ["pwd"],
  timeoutMs: 10_000,
};

describe("runInMicroVm url guard", () => {
  const rejected = [
    "git@github.com:owner/repo.git", // scp-style: no scheme at all
    "ssh://git@github.com/owner/repo.git",
    "http://github.com/owner/repo.git", // plain http can be rewritten in transit
    "file:///home/me/repo",
    "github.com/owner/repo",
    "",
    "https://", // https but no host
  ];

  for (const repoUrl of rejected) {
    test(`rejects ${JSON.stringify(repoUrl)} before creating anything`, async () => {
      const vm = fakeVm();
      await expect(runInMicroVm({ ...OPTS, repoUrl }, vm.client)).rejects.toThrow(
        /repo URL must be https/,
      );
      expect(vm.events).toEqual([]);
      expect(vm.stops()).toHaveLength(0);
    });
  }

  test("rejects an empty command before creating anything", async () => {
    const vm = fakeVm();
    await expect(runInMicroVm({ ...OPTS, command: [] }, vm.client)).rejects.toThrow(/empty/);
    expect(vm.events).toEqual([]);
  });
});

describe("runInMicroVm run sequence", () => {
  test("create, write files, clone, run the command, stop", async () => {
    const vm = fakeVm(cloneThen({ code: 0, stdout: "command out", stderr: "" }));
    const result = await runInMicroVm(
      { ...OPTS, files: { "README.md": "hello", "src/main.ts": "console.log(1)" } },
      vm.client,
    );

    expect(result).toEqual({ code: 0, stdout: "command out", stderr: "", timedOut: false });
    expect(vm.kinds()).toEqual(["create", "write", "write", "exec", "exec", "stop"]);
    expect(vm.stops()).toHaveLength(1);

    const [clone, run] = vm.execs();
    expect(clone!.cmd).toEqual([
      "git",
      "clone",
      "--filter=blob:none",
      "https://github.com/owner/repo.git",
      "/work",
    ]);
    expect(clone!.timeoutMs).toBe(10_000);
    expect(run!.timeoutMs).toBe(10_000);
    // the command itself is not on the wire; the VM runs it after entering /work
    expect(run!.cmd[0]).toBe("/bin/sh");

    expect(vm.writes()).toEqual([
      { kind: "write", id: "vm-1", path: "README.md", content: "hello" },
      { kind: "write", id: "vm-1", path: "src/main.ts", content: "console.log(1)" },
    ]);
  });

  test("writes nothing when no files are given", async () => {
    const vm = fakeVm();
    await runInMicroVm(OPTS, vm.client);
    expect(vm.kinds()).toEqual(["create", "exec", "exec", "stop"]);
    expect(vm.writes()).toEqual([]);
  });

  test("runs the command in /work with arguments passed through intact", async () => {
    const vm = fakeVm(cloneThen({ code: 0, stdout: "", stderr: "" }));
    await runInMicroVm({ ...OPTS, command: ["echo", "hello world", "it's"] }, vm.client);

    const script = vm.execs()[1]!.cmd[2]!;
    expect(script.startsWith("cd /work && exec ")).toBe(true);
    expect(script).toContain("echo");
    expect(script).toContain("'hello world'");
    expect(script).toContain("'it'\\''s'");
  });

  test("a clone failure is returned and the command never runs", async () => {
    const vm = fakeVm({
      exec: (_cmd, call) => (call === 1 ? { code: 128, stdout: "", stderr: "fatal: nope" } : { code: 0, stdout: "ran", stderr: "" }),
    });
    const result = await runInMicroVm(OPTS, vm.client);

    expect(result).toEqual({ code: 128, stdout: "", stderr: "fatal: nope", timedOut: false });
    expect(vm.kinds()).toEqual(["create", "exec", "stop"]);
  });

  test("a command failure is returned and the VM still stops", async () => {
    const vm = fakeVm(cloneThen({ code: 1, stdout: "out", stderr: "boom" }));
    const result = await runInMicroVm(OPTS, vm.client);
    expect(result).toEqual({ code: 1, stdout: "out", stderr: "boom", timedOut: false });
    expect(vm.stops()).toHaveLength(1);
  });
});

describe("runInMicroVm timeouts", () => {
  test("a command timeout returns code 124 and timedOut", async () => {
    const vm = fakeVm(cloneThen({ code: 124, stdout: "partial", stderr: "timeout" }));
    const result = await runInMicroVm({ ...OPTS, command: ["sleep", "10"], timeoutMs: 100 }, vm.client);
    expect(result).toEqual({ code: 124, stdout: "partial", stderr: "timeout", timedOut: true });
    expect(vm.stops()).toHaveLength(1);
  });

  test("a clone timeout returns code 124 and timedOut, and skips the command", async () => {
    const vm = fakeVm({ exec: () => ({ code: 124, stdout: "", stderr: "clone timed out" }) });
    const result = await runInMicroVm({ ...OPTS, timeoutMs: 100 }, vm.client);
    expect(result).toEqual({ code: 124, stdout: "", stderr: "clone timed out", timedOut: true });
    expect(vm.kinds()).toEqual(["create", "exec", "stop"]);
  });
});

describe("runInMicroVm failure paths", () => {
  test("a rejected exec propagates and the VM still stops", async () => {
    const vm = fakeVm({
      exec: (_cmd, call) => {
        if (call === 1) return { code: 0, stdout: "", stderr: "" };
        throw new Error("vm exploded");
      },
    });
    await expect(runInMicroVm(OPTS, vm.client)).rejects.toThrow("vm exploded");
    expect(vm.stops()).toHaveLength(1);
    expect(vm.kinds()).toEqual(["create", "exec", "exec", "stop"]);
  });

  test("a rejected write stops the VM and propagates", async () => {
    const events: string[] = [];
    const vm = fakeVm();
    const client: MicroVmClient = {
      ...vm.client,
      async write() {
        events.push("write");
        throw new Error("disk full");
      },
    };
    await expect(runInMicroVm({ ...OPTS, files: { "a.txt": "x" } }, client)).rejects.toThrow(
      "disk full",
    );
    expect(vm.stops()).toHaveLength(1);
    expect(vm.execs()).toHaveLength(0);
  });

  test("a failing stop does not mask the run failure", async () => {
    const vm = fakeVm({
      exec: (_cmd, call) => {
        if (call === 1) return { code: 0, stdout: "", stderr: "" };
        throw new Error("vm exploded");
      },
      stop: () => Promise.reject(new Error("stop failed")),
    });
    await expect(runInMicroVm(OPTS, vm.client)).rejects.toThrow("vm exploded");
    expect(vm.stops()).toHaveLength(1);
  });

  test("a failing stop on a successful run is reported", async () => {
    const vm = fakeVm({ stop: () => Promise.reject(new Error("stop failed")) });
    await expect(runInMicroVm(OPTS, vm.client)).rejects.toThrow("stop failed");
    expect(vm.stops()).toHaveLength(1);
  });

  test("a rejected create reports the error and has nothing to stop", async () => {
    const vm = fakeVm({ create: () => Promise.reject(new Error("no capacity")) });
    await expect(runInMicroVm(OPTS, vm.client)).rejects.toThrow("no capacity");
    expect(vm.stops()).toHaveLength(0);
    expect(vm.kinds()).toEqual(["create"]);
  });
});
