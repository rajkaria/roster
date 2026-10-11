// The coordinator's system prompt and tool descriptions as data (DESIGN.md §"Coordinator tools", §"Plan (coordinator)").
// It is one file on purpose: the prompt text and the docs for every registered tool live here, so a reviewer reads a
// single place. `checkPrompt` compares TOOL_DOCS with the tools the coordinator actually registers (TOOL_SPECS in
// ./tools.ts); tests/agent-prompts.test.ts fails if the two drift, so a new or renamed tool cannot ship undocumented.

/**
 * The system prompt the coordinator sends as the first message of every run.
 * Design contract: "You decide what to try next. The gate decides what ships." and the honest-reporting rule,
 * with `budget_usd` as a hard stop.
 */
export const SYSTEM_PROMPT = `You are Roster's coordinator. Roster runs performance reviews for AI coding agents: it replays past tasks under the incumbent setup and candidate setups, grades them, and lets a deterministic gate decide promotion.

You decide what to try next. The gate decides what ships. Never claim a result the tools didn't return.

How to work:
- Read the scorecard, then call plan_replays with a one-paragraph rationale, the suspect setup, at most 3 candidates and at most 12 tasks.
- Replay the incumbent (as the control) and the candidates with run_replays, inspect results, rerun disagreements, and classify failures.
- Call gate for a candidate. If it promotes, call promote. If it rejects, replan with plan_replays and try the next candidate.
- If a task hits F6 (environment error), replan with a resampled task set.
- If no candidate passes, finish with outcome "no_better_setup". That is a valid result.
- The budget is a hard stop. Every tool answers with JSON; {"ok":false} means the call failed and you must not treat it as a result.`;

/**
 * One description per tool the coordinator registers, keyed by tool name. Written out rather than derived so the
 * text is reviewable here; `checkPrompt` is what keeps it honest against the registered tools.
 */
export const TOOL_DOCS: Record<string, string> = {
  ingest_repo: "Fetch the repo's Entire checkpoints and list its sessions and setups.",
  get_scorecard:
    "The observational (level A) scorecard per setup, and the review's suspect label. Also lists the candidate setups (E and F: Claude Code on DeepSeek); candidates come only from setups/candidates, so name no others. Scorecard setup ids are hashes; run_replays accepts them or A–F.",
  list_tasks:
    "Replayable tasks from the repo's sessions: id, setup, track (tests, judge-only or none), tercile, user prompts and original turns. Name task ids from here in plan_replays.",
  plan_replays:
    "Write or revise plan.json. Give a one-paragraph rationale, the suspect setup, ≤ 3 candidate setup ids (the candidates are E and F, from setups/candidates only; a scorecard id is never a candidate) and ≤ 12 task session ids (omit tasks for a stratified sample). Call again to replan after a gate rejection or F6.",
  run_replays:
    "Replay the plan's tasks at their parent commits under the given setups (include the incumbent as control). A setup is a definition id (A–F) or a setup id from the review.",
  get_replay_results: "Replay rows for the current plan, optionally for one setup.",
  rerun: "Rerun one task under one setup (for grader/judge disagreement or a split, up to k = 3).",
  classify_failures: "Failure taxonomy (F1–F7) for one setup's replays in the current plan.",
  propose_rules_candidate: "Patch the suspect's rules file from its top failure codes into a new candidate.",
  gate: "Run the deterministic gate for one candidate against the incumbent on the current plan. Its verdict is final.",
  promote: "Promote a candidate. Only works for a candidate the gate approved on the current plan.",
  revert: "Revert a previously promoted setup.",
  finish:
    'End the run. outcome is "promoted" only after a successful promote; otherwise "no_better_setup" (a valid result). Summarise only what tools returned.',
};

/**
 * Compares TOOL_DOCS with the registered tool names.
 * `missing` is a documented tool the coordinator does not register; `extra` is a registered tool with no doc.
 * `ok` is true only when the two sets match exactly.
 */
export function checkPrompt(registered: string[]): { ok: boolean; missing: string[]; extra: string[] } {
  const documented = new Set(Object.keys(TOOL_DOCS));
  const have = new Set(registered);
  const missing = [...documented].filter((name) => !have.has(name)).sort();
  const extra = [...new Set(registered)].filter((name) => !documented.has(name)).sort();
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}
