// Local copy of the review shape (web/ must build without ../src). Mirrors SetupRow, ReviewTags and Review
// in src/types.ts; keep the two in step. Rates are fractions in [0, 1] over mature sessions, or null.

export type EvidenceLevel = "A" | "B" | "C";
export type ReviewLabel = "suspect" | "no_suspect" | "insufficient_data";

export interface SetupRow {
  setup_id: string;
  label: string;
  harness: string;
  model: string;
  rules_hash: string | null;
  sessions: number;
  mature_sessions: number;
  spend_usd: number;
  unattended: number | null;
  survival: number | null;
  reverted: number | null;
  rework_human: number | null;
  surviving_changes: number;
  cost_per_surviving_change: number | null;
  evidence_level: EvidenceLevel;
}

export interface ReviewTags {
  by_tag: Record<string, { sessions: number; setup_ids: string[] }>;
  tag_accuracy: number | null;
}

export interface Review {
  id: string;
  repo: string; // "owner/name"
  created_at: string;
  generated_at: string; // ISO timestamp
  has_entire_data: boolean;
  setups: SetupRow[];
  tags?: ReviewTags;
  label: ReviewLabel;
  suspect: string | null;
  odds_ratio: number | null;
  ci95: [number, number] | null;
  p_value: number | null;
  evidence_level: EvidenceLevel;
  /** Only the checked-in layout sample sets this. */
  sample?: boolean;
}
