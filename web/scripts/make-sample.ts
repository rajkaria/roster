// Generates reports/_sample/review.json (clearly-labelled sample data, not real results).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Review } from "../lib/types";

const review: Review = {
  repo: "_sample/_sample",
  generated_at: "2026-01-01T00:00:00.000Z",
  has_entire_data: true,
  sample: true,
  setups: [
    {
      setup_id: "sample-a",
      label: "Sample A",
      harness: "claude-code",
      model: "sample-model-1",
      rules_hash: "aaaaaaa",
      sessions: 10,
      spend_usd: 20,
      unattended: 0.5,
      survival: 0.8,
      reverted: 0.1,
      rework_human: 0.2,
      surviving_changes: 8,
      evidence_level: "A",
    },
    {
      setup_id: "sample-b",
      label: "Sample B",
      harness: "codex",
      model: "sample-model-2",
      rules_hash: null,
      sessions: 4,
      spend_usd: 6,
      unattended: null,
      survival: null,
      reverted: null,
      rework_human: null,
      surviving_changes: 0,
      evidence_level: "A",
    },
  ],
};

const dir = join(import.meta.dir, "..", "..", "reports", "_sample");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "review.json"), JSON.stringify(review, null, 2) + "\n");
console.log(`wrote ${dir}/review.json`);
