// Local copy of the review shape (web/ must build without ../src).
// Derived from docs/DESIGN.md "Data model"; src/types.ts did not exist when this was written.
// Rates are fractions in [0, 1] or null when not computable.

export type EvidenceLevel = "A" | "B" | "C";

export interface SetupRow {
  setup_id: string;
  label: string;
  harness: string;
  model: string;
  rules_hash: string | null;
  sessions: number;
  spend_usd: number;
  unattended: number | null;
  survival: number | null;
  reverted: number | null;
  rework_human: number | null;
  surviving_changes: number;
  evidence_level: EvidenceLevel;
}

export interface Review {
  repo: string; // "owner/name"
  generated_at: string; // ISO timestamp
  has_entire_data: boolean;
  sample?: boolean;
  setups: SetupRow[];
}
