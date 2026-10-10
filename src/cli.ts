#!/usr/bin/env bun
// Roster's command line. Each command lives in src/cli/<cmd>.ts and exports a Command; register it in COMMANDS below.
// See docs/DESIGN.md §"CLI".
import { reviewCommand } from "./cli/review.ts";

export interface Command {
  name: string;
  summary: string;
  usage: string;
  /** Runs the command with the arguments after its name. Resolves to the process exit code. */
  run: (args: string[]) => Promise<number>;
}

export const COMMANDS: readonly Command[] = [reviewCommand];

function printUsage(out: (s: string) => void): void {
  out("usage: roster <command> [args]\n");
  out("commands:");
  for (const c of COMMANDS) out(`  ${c.name.padEnd(10)} ${c.summary}`);
}

/** Dispatches argv (without the runtime and script path) to a command. Resolves to the exit code. */
export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined) {
    printUsage((s) => console.error(s));
    return 2;
  }
  if (name === "--help" || name === "-h" || name === "help") {
    printUsage((s) => console.log(s));
    return 0;
  }
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) {
    console.error(`roster: unknown command "${name}"\n`);
    printUsage((s) => console.error(s));
    return 2;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(cmd.usage);
    return 0;
  }
  try {
    return await cmd.run(rest);
  } catch (err) {
    console.error(`roster ${cmd.name}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
