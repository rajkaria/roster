// Setup registry (DESIGN.md §"Setups", §"Candidate generation").
//
//   const setups = loadSetups(repoRoot, process.env);   // sorted by id
//
// Reads setups/*.json (candidate: false) and setups/candidates/*.json (candidate: true). Never throws on a
// missing provider variable: that candidate is returned with env {} and an "(unavailable: <VAR> not set)" label.
// Only variable names are ever reported, never values.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { providerEnv } from "../harness/provider";

export interface RunnableSetup {
  id: string;
  label: string;
  harness: "claude-code" | "codex";
  model: string;
  rulesPath: string;
  extraRulesPath: string | null;
  env: Record<string, string>;
  candidate: boolean;
}

interface SetupFile {
  id: string;
  label?: string;
  harness: "claude-code" | "codex";
  model: string;
  rules: string;
  append_rules?: string;
  env?: Record<string, string>;
}

const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function readDir(dir: string, candidate: boolean): Array<{ file: SetupFile; candidate: boolean }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ file: JSON.parse(readFileSync(join(dir, f), "utf8")) as SetupFile, candidate }));
}

function missingVars(file: SetupFile, env: Record<string, string | undefined>): string[] {
  const missing: string[] = [];
  for (const raw of Object.values(file.env ?? {})) {
    for (const m of raw.matchAll(REF)) {
      const name = m[1]!;
      const v = env[name];
      if ((v === undefined || v === "") && !missing.includes(name)) missing.push(name);
    }
  }
  return missing;
}

export function loadSetups(root: string, env: Record<string, string | undefined>): RunnableSetup[] {
  const entries = [...readDir(join(root, "setups"), false), ...readDir(join(root, "setups", "candidates"), true)];
  const out: RunnableSetup[] = entries.map(({ file, candidate }) => {
    const missing = missingVars(file, env);
    let label = file.label ?? file.id;
    let resolved: Record<string, string> = {};
    if (missing.length > 0) {
      label += ` (unavailable: ${missing.join(", ")} not set)`;
    } else {
      try {
        resolved = providerEnv(file, env);
      } catch {
        label += " (unavailable: provider env could not be resolved)";
      }
    }
    return {
      id: file.id,
      label,
      harness: file.harness,
      model: file.model,
      rulesPath: join(root, file.rules),
      extraRulesPath: file.append_rules ? join(root, file.append_rules) : null,
      env: resolved,
      candidate,
    };
  });
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
