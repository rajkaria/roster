// Replayable tasks from recorded sessions (DESIGN.md §"Plan (coordinator)", §"Replay at the parent commit"):
// what was asked, the commit to start from, and the tests the team kept.

import { hiddenTestsForCommits } from "../grade/hidden.ts";
import { runGit } from "../sandbox/index.ts";
import type { Outcome, Session } from "../types.ts";

export interface ReplayTask {
  /** Same as the session id. */
  id: string;
  sessionId: string;
  setupId: string | null;
  /** The `roster setup=… task=…` tag text that led the first prompt, if any. */
  tag: string | null;
  prompt: string;
  /** First parent of the session's earliest linked commit. */
  parentSha: string;
  /** The session's latest linked commit. */
  originalSha: string;
  hiddenTests: { path: string; content: string }[];
  userPrompts: number;
  /** Assistant turns in the original session's transcript; null when the transcript is not available. */
  originalTurns: number | null;
  tercile: 1 | 2 | 3 | null;
  track: "tests" | "judge-only" | "none";
  reason: string;
}

export interface SkippedSession {
  sessionId: string;
  reason: string;
}

/** Most user prompts a session may have and still be eligible for replay. */
const MAX_PROMPTS = 2;
const TAG_LINE = /^\s*\[(roster setup=[^\]]*)\][ \t]*\r?\n?/;
const BRANCH_REFS = ["refs/heads/entire/checkpoints/v1", "refs/remotes/origin/entire/checkpoints/v1"];

function tryGit(repo: string, args: string[]): string | null {
  try {
    return runGit(repo, args);
  } catch {
    return null;
  }
}

/** Splits a leading roster tag off a prompt. */
export function stripTag(prompt: string): { tag: string | null; prompt: string } {
  const m = TAG_LINE.exec(prompt);
  return m ? { tag: m[1]!, prompt: prompt.slice(m[0].length).trim() } : { tag: null, prompt: prompt.trim() };
}

interface Link {
  sha: string;
  time: number;
  importStrategy: boolean;
  /** Assistant turns in this link's session transcript, read on demand; null when unreadable. */
  turns: () => number | null;
}

/** Assistant turns in a Claude Code transcript: distinct assistant messages (one message can span several rows). */
export function countAssistantTurns(text: string | null): number | null {
  if (!text) return null;
  const ids = new Set<string>();
  let anon = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r?.type !== "assistant" || !r.message) continue;
    if (typeof r.message.id === "string" && r.message.id) ids.add(r.message.id);
    else anon++;
  }
  const n = ids.size + anon;
  return n > 0 ? n : null;
}

/** Session id → commits whose checkpoint trailer names a checkpoint holding that session. */
function linkIndex(repo: string): Map<string, Link[]> {
  const index = new Map<string, Link[]>();
  const log = tryGit(repo, [
    "log",
    "--all",
    "--format=%H%x1f%ct%x1f%(trailers:key=Entire-Checkpoint,valueonly,separator=%x2c)%x1e",
  ]);
  const ref = BRANCH_REFS.find((r) => tryGit(repo, ["rev-parse", "--verify", "-q", r]) !== null);
  if (!log || !ref) return index;
  const show = (path: string): any => {
    const out = tryGit(repo, ["show", `${ref}:${path}`]);
    try {
      return out === null ? null : JSON.parse(out);
    } catch {
      return null;
    }
  };
  for (const rec of log.split("\x1e")) {
    const [sha, ct, ids] = rec.trim().split("\x1f");
    if (!sha || !ids) continue;
    for (const id of ids.split(",").map((s) => s.trim()).filter(Boolean)) {
      const dir = `${id.slice(0, 2)}/${id.slice(2)}`;
      const root = show(`${dir}/metadata.json`);
      if (!root) continue;
      const n = Array.isArray(root.sessions) ? root.sessions.length : 0;
      for (let i = 0; i < n; i++) {
        const sid = show(`${dir}/${i}/metadata.json`)?.session_id;
        if (typeof sid !== "string") continue;
        (index.get(sid) ?? index.set(sid, []).get(sid)!).push({
          sha,
          time: Number(ct),
          importStrategy: root.strategy === "import",
          turns: () => countAssistantTurns(tryGit(repo, ["show", `${ref}:${dir}/${i}/full.jsonl`])),
        });
      }
    }
  }
  return index;
}

/** Tasks plus the sessions that could not become one, each with its reason. */
export function planReplayTasks(
  repo: string,
  sessions: Session[],
  outcomes: Outcome[],
): { tasks: ReplayTask[]; skipped: SkippedSession[] } {
  const tercile = new Map(outcomes.map((o) => [o.session_id, o.tercile]));
  const links = linkIndex(repo);
  const tasks: (ReplayTask & { time: number })[] = [];
  const skipped: SkippedSession[] = [];
  const seen = new Set<string>();

  for (const s of sessions) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    const mine = sessions.filter((x) => x.id === s.id);
    const found = new Map<string, Link>((links.get(s.id) ?? []).map((l) => [l.sha, l]));
    for (const x of mine) {
      if (x.commit_sha && !found.has(x.commit_sha)) {
        const t = tryGit(repo, ["show", "-s", "--format=%ct", x.commit_sha]);
        if (t !== null) found.set(x.commit_sha, { sha: x.commit_sha, time: Number(t), importStrategy: false, turns: () => null });
      }
    }
    const commits = [...found.values()].sort((a, b) => a.time - b.time || a.sha.localeCompare(b.sha));
    if (commits.length === 0) {
      skipped.push({ sessionId: s.id, reason: "no linked commit" });
      continue;
    }
    const earliest = commits[0]!;
    const latest = commits.at(-1)!;
    const parentSha = tryGit(repo, ["rev-parse", `${earliest.sha}^1`]);
    if (!parentSha) {
      skipped.push({ sessionId: s.id, reason: `earliest commit ${earliest.sha.slice(0, 7)} has no parent` });
      continue;
    }

    const userPrompts = Math.max(...mine.map((x) => x.n_user_prompts));
    const tests = hiddenTestsForCommits(repo, commits.map((c) => c.sha));
    let track: ReplayTask["track"];
    let reason: string;
    if (commits.some((c) => c.importStrategy)) [track, reason] = ["none", "imported history, not captured live"];
    else if (userPrompts > MAX_PROMPTS) [track, reason] = ["none", `${userPrompts} user prompts (more than ${MAX_PROMPTS})`];
    else if (tests.length === 0) [track, reason] = ["judge-only", "no hidden tests in the original change"];
    else [track, reason] = ["tests", `${tests.length} hidden test file(s)`];

    const turnCounts = (links.get(s.id) ?? []).map((l) => l.turns()).filter((n): n is number => n !== null);
    const originalTurns = turnCounts.length ? Math.max(...turnCounts) : null;

    const { tag, prompt } = stripTag(s.first_prompt);
    tasks.push({
      id: s.id,
      sessionId: s.id,
      setupId: s.setup_id,
      tag,
      prompt,
      parentSha,
      originalSha: latest.sha,
      hiddenTests: tests,
      userPrompts,
      originalTurns,
      tercile: tercile.get(s.id) ?? null,
      track,
      reason,
      time: latest.time,
    });
  }
  tasks.sort((a, b) => a.time - b.time || a.originalSha.localeCompare(b.originalSha) || a.id.localeCompare(b.id));
  return { tasks: tasks.map(({ time: _t, ...t }) => t), skipped };
}

export function buildReplayTasks(repo: string, sessions: Session[], outcomes: Outcome[]): ReplayTask[] {
  return planReplayTasks(repo, sessions, outcomes).tasks;
}
