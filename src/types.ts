// Shared contracts for every Roster module. Shapes follow docs/DESIGN.md §"Data model".
// Change minimally, and say so in your PR.

/** Evidence level printed next to every claim: A observational, B controlled replay, C forward. */
export type EvidenceLevel = "A" | "B" | "C";
export const EVIDENCE_LEVELS: readonly EvidenceLevel[] = ["A", "B", "C"] as const;

/** Failure taxonomy (DESIGN.md §"Grade"). */
export enum FailureCode {
  /** edited tests */
  F1 = "F1",
  /** never ran tests */
  F2 = "F2",
  /** suite regression */
  F3 = "F3",
  /** stopped early */
  F4 = "F4",
  /** loop, timeout or turn cap */
  F5 = "F5",
  /** environment or setup error; the task is excluded and resampled */
  F6 = "F6",
  /** off-scope edits */
  F7 = "F7",
}

/** Where a session row came from. */
export type SessionSource = "branch" | "git-refs";

/** One agent session, aggregated over all checkpoints it appears in. Table `sessions`. */
export interface Session {
  id: string;
  repo: string;
  checkpoint_id: string;
  harness: string;
  /** Resolved model, or "unknown" when neither metadata nor transcript records it. */
  model: string;
  /** sha256 of the normalised rules file; null when unknown, never a guess. */
  rules_hash: string | null;
  setup_id: string | null;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  /** null when the model's price is unknown. */
  cost_usd: number | null;
  n_user_prompts: number;
  first_prompt: string;
  /** null when no commit carries this session's checkpoint trailer. */
  commit_sha: string | null;
  started_at: string;
  ended_at: string;
  files: string[];
  entire_url: string | null;
  source: SessionSource;
}

export type OutcomeStatus = "mature" | "too_young";
export type Tercile = 1 | 2 | 3;

/** Score of one session. Metrics are null when status is too_young. Table `outcomes`. */
export interface Outcome {
  session_id: string;
  status: OutcomeStatus;
  survival: number | null;
  reverted: boolean | null;
  rework_human: number | null;
  rework_agent: number | null;
  unattended: boolean | null;
  tests_at_commit: boolean | null;
  difficulty: number | null;
  tercile: Tercile | null;
}

/** Setup = harness + model + rules_hash. Table `setups`. */
export interface Setup {
  id: string;
  harness: string;
  model: string;
  rules_hash: string | null;
  rules_path: string | null;
  label: string;
}

/** Coordinator plan. Table `plans`; `json` holds the serialised PlanBody. */
export interface Plan {
  id: string;
  review_id: string;
  json: string;
  rationale: string;
  created_at: string;
}

/** Body of plan.json (DESIGN.md §"Plan (coordinator)"). */
export interface PlanBody {
  suspect: string | null;
  /** Session ids, ≤ 12, stratified by tercile. */
  tasks: string[];
  /** Setup ids, ≤ 3 per iteration. */
  candidates: string[];
  budget_usd: number;
  stop_rules: string[];
  rationale: string;
}

export type ReplayVerdict =
  | "agent_error"
  | "no_changes"
  | "hidden_tests_failed"
  | "suite_failed"
  | "guardrail_flagged"
  | "pass";

/** One replay attempt of a task under a setup. Table `replays`. */
export interface Replay {
  id: string;
  plan_id: string;
  task_session_id: string;
  setup_id: string;
  attempt: number;
  isolation_proof: string;
  turns: number | null;
  duration_ms: number | null;
  cost_usd: number | null;
  hidden_pass: boolean | null;
  suite_pass: boolean | null;
  scope_ok: boolean | null;
  judge_equiv: boolean | null;
  failure_codes: FailureCode[];
  verdict: ReplayVerdict;
  transcript_ref: string | null;
  trace_url: string | null;
  /** Why the run failed before or inside the harness (environment error or harness error kind); null when it did not. */
  error?: string | null;
  /** The turn cap this run was given. */
  turn_cap?: number | null;
}

/** `no_signal`: the replay measure cannot rank setups (the incumbent fails its own tasks); nothing is promoted. */
export type GateVerdict = "promote" | "reject" | "no_signal";

/** Table `gate_decisions`. */
export interface GateDecision {
  id: string;
  plan_id: string;
  candidate: string;
  verdict: GateVerdict;
  reasons: string[];
  trace_url: string | null;
}

/** One pre-registered forward task run through both setups. Table `forward_pairs`. */
export interface ForwardPair {
  task_id: string;
  setup_old: string;
  setup_new: string;
  pass_old: boolean;
  pass_new: boolean;
  cost_old: number | null;
  cost_new: number | null;
  /** Which setup's change was merged, if any. */
  merged: "old" | "new" | null;
  /** Blind label assignment, e.g. { X: "old", Y: "new" }. */
  blind_labels: Record<string, "old" | "new">;
  seed: number;
  /** Each side's full suite and scope guard, graded with the acceptance tests; null on rows recorded before they were kept. */
  suite_pass_old?: boolean | null;
  suite_pass_new?: boolean | null;
  scope_ok_old?: boolean | null;
  scope_ok_new?: boolean | null;
  /** Why `merged` is what it is. The suite_scope* reasons are amendment 8's build-only policy for both-fail pairs. */
  merged_reason?:
    | "pass_beats_fail"
    | "judge"
    | "random_tie"
    | "suite_scope"
    | "suite_scope_judge"
    | "suite_scope_random_tie"
    | "both_failed"
    | "merge_failed"
    | null;
  /** Exploratory secondary outcome (amendment 8), never H1: the blind judge's preference among sides whose suite and scope pass. */
  secondary?: "old" | "new" | "tie" | "none" | null;
}

export type ReviewLabel = "suspect" | "no_suspect" | "insufficient_data";

/** One setup's row in a review. Rates are fractions in [0, 1] over mature sessions, null when there are none. */
export interface SetupRow {
  setup_id: string;
  label: string;
  harness: string;
  model: string;
  rules_hash: string | null;
  sessions: number;
  mature_sessions: number;
  /** Σ session cost; null when any session in the setup is unpriced (never 0 from nulls). */
  spend_usd: number | null;
  /** Sessions with a known cost. Equals `sessions` exactly when spend_usd is non-null. */
  priced_sessions: number;
  /** True when a priced session's prompt size was unknown, so spend_usd is priced at the short tier and is a floor. */
  spend_lower_bound: boolean;
  unattended: number | null;
  survival: number | null;
  reverted: number | null;
  rework_human: number | null;
  /** Σ survival over mature sessions. */
  surviving_changes: number;
  cost_per_surviving_change: number | null;
  evidence_level: EvidenceLevel;
}

/** Ground-truth prompt tags (`[roster setup=<tag> ...]`) against the setup ids Roster inferred. */
export interface ReviewTags {
  by_tag: Record<string, { sessions: number; setup_ids: string[] }>;
  tag_accuracy: number | null;
}

/** Difficulty-matched scorecard result (DESIGN.md §"Difficulty and review"). */
export interface Review {
  id: string;
  /** "owner/name" */
  repo: string;
  created_at: string;
  generated_at: string;
  has_entire_data: boolean;
  setups: SetupRow[];
  /** Present only when sessions carry prompt tags. */
  tags?: ReviewTags;
  label: ReviewLabel;
  /** Setup id when label is "suspect". */
  suspect: string | null;
  /** Mantel–Haenszel odds ratio, setup X vs the rest, stratified by tercile. */
  odds_ratio: number | null;
  ci95: [number, number] | null;
  p_value: number | null;
  evidence_level: EvidenceLevel;
}
