import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { COMMANDS } from "../src/cli.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const NAMES = ["review", "run", "forward", "acceptance"];

function runCli(args: string[]) {
  const p = Bun.spawnSync(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

describe("CLI registry", () => {
  test("registers review, run, forward and acceptance", () => {
    const names = COMMANDS.map((c) => c.name);
    for (const n of NAMES) expect(names).toContain(n);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every command has a summary and usage", () => {
    for (const c of COMMANDS) {
      expect(c.summary.trim().length).toBeGreaterThan(0);
      expect(c.usage.trim().length).toBeGreaterThan(0);
    }
  });

  test("`roster acceptance --help` exits 0 with usage text", () => {
    const acceptance = COMMANDS.find((c) => c.name === "acceptance");
    const r = runCli(["acceptance", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(acceptance?.usage.trim() ?? "<missing>");
  });

  test("`roster --help` lists all four commands", () => {
    const r = runCli(["--help"]);
    expect(r.code).toBe(0);
    for (const n of NAMES) expect(r.stdout).toMatch(new RegExp(`^  ${n}\\s`, "m"));
  });

  test("unknown commands print usage and exit 2", () => {
    const r = runCli(["nope"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown command "nope"');
    expect(r.stderr).toContain("usage: roster");
  });
});
