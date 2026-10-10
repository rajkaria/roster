// Optional per-review files next to review.json: replays.json, gate_decisions.json, forward_pairs.json,
// outcomes.json. Each is an array of the rows in src/types.ts (Replay, GateDecision, ForwardPair, Outcome).
// A missing or unreadable file is an empty list, which the page shows as an empty state.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ReplayRow {
  id: string;
  task_session_id: string;
  setup_id: string;
  attempt: number;
  cost_usd: number | null;
  hidden_pass: boolean | null;
  failure_codes: string[];
  verdict: string;
  trace_url: string | null;
  entire_url?: string | null;
}
export interface GateRow {
  id: string;
  candidate: string;
  verdict: string;
  reasons: string[];
  trace_url: string | null;
}
export interface ForwardRow {
  task_id: string;
  setup_old: string;
  setup_new: string;
  pass_old: boolean;
  pass_new: boolean;
  cost_old: number | null;
  cost_new: number | null;
  merged: "old" | "new" | null;
}
export interface OutcomeRow {
  session_id: string;
  tercile: number | null;
}

const DATA = join(process.cwd(), "public", "data");

function dirFor(owner: string, repo: string): string | null {
  const list = [`${owner}__${repo}`, `${owner}-${repo}`, join(owner, repo)];
  if (owner === "_sample" && repo === "_sample") list.unshift("_sample");
  for (const c of list) if (existsSync(join(DATA, c, "review.json"))) return join(DATA, c);
  return null;
}

function readList<T>(owner: string, repo: string, name: string): T[] {
  const dir = dirFor(owner, repo);
  if (!dir) return [];
  const file = join(dir, name);
  if (!existsSync(file)) return [];
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

export const loadReplays = (o: string, r: string) => readList<ReplayRow>(o, r, "replays.json");
export const loadGate = (o: string, r: string) => readList<GateRow>(o, r, "gate_decisions.json");
export const loadForward = (o: string, r: string) => readList<ForwardRow>(o, r, "forward_pairs.json");
export const loadOutcomes = (o: string, r: string) => readList<OutcomeRow>(o, r, "outcomes.json");
