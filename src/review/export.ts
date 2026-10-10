// Writes one observational review to reports/<slug>/: review.json (the Review type, validated before
// it is written), sessions.json, outcomes.json and review.md. See docs/DESIGN.md §"Data model" and §"Review".
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { EvidenceLevel, Outcome, Review, ReviewLabel, Session } from "../types.ts";

/** Keys of the Review type in src/types.ts. Kept in step by the `satisfies Review` check in tests. */
export const REVIEW_KEYS = [
  "id",
  "repo",
  "created_at",
  "label",
  "suspect",
  "odds_ratio",
  "ci95",
  "p_value",
  "evidence_level",
] as const;

const LABELS: readonly ReviewLabel[] = ["suspect", "no_suspect", "insufficient_data"];
const EVIDENCE: readonly EvidenceLevel[] = ["A", "B", "C"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** "owner/name" for a GitHub URL, otherwise the last path segment. */
export function repoLabel(repo: string): string {
  const trimmed = repo.trim();
  const remote = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (remote) return `${remote[1]}/${remote[2]}`;
  return basename(trimmed.replace(/\/+$/, "").replace(/\.git$/, ""));
}

/** Directory name under reports/: "owner__name" for GitHub repos (the web app's lookup form), else the basename. */
export function reviewSlug(repo: string): string {
  return repoLabel(repo).replace("/", "__").replace(/[^A-Za-z0-9._-]+/g, "-");
}

/** Lists every way `value` fails the Review type. An empty list means it validates. */
export function validateReview(value: unknown): string[] {
  if (!isRecord(value)) return ["review must be an object"];
  const errs: string[] = [];
  for (const k of REVIEW_KEYS) if (!(k in value)) errs.push(`missing ${k}`);
  for (const k of Object.keys(value)) if (!(REVIEW_KEYS as readonly string[]).includes(k)) errs.push(`unexpected key ${k}`);

  for (const k of ["id", "repo", "created_at"] as const) {
    if (typeof value[k] !== "string" || value[k] === "") errs.push(`${k} must be a non-empty string`);
  }
  if (typeof value.created_at === "string" && Number.isNaN(Date.parse(value.created_at))) errs.push("created_at is not a date");

  const label = value.label;
  if (!(LABELS as readonly unknown[]).includes(label)) errs.push(`label must be one of ${LABELS.join(", ")}`);
  if (label === "suspect") {
    if (typeof value.suspect !== "string" || value.suspect === "") errs.push("suspect must name a setup when label is suspect");
    if (!isFiniteNum(value.odds_ratio)) errs.push("odds_ratio must be a number when label is suspect");
    if (!Array.isArray(value.ci95)) errs.push("ci95 must be set when label is suspect");
    if (!isFiniteNum(value.p_value)) errs.push("p_value must be a number when label is suspect");
  } else if (value.suspect !== null) {
    errs.push("suspect must be null unless label is suspect");
  }

  if (value.odds_ratio !== null && !(isFiniteNum(value.odds_ratio) && value.odds_ratio >= 0)) {
    errs.push("odds_ratio must be null or a number >= 0");
  }
  const ci = value.ci95;
  if (ci !== null) {
    const ok = Array.isArray(ci) && ci.length === 2 && ci.every(isFiniteNum) && ci[0]! <= ci[1]!;
    if (!ok) errs.push("ci95 must be null or [low, high] with low <= high");
  }
  if (value.p_value !== null && !(isFiniteNum(value.p_value) && value.p_value >= 0 && value.p_value <= 1)) {
    errs.push("p_value must be null or a number in [0, 1]");
  }
  if (!(EVIDENCE as readonly unknown[]).includes(value.evidence_level)) errs.push("evidence_level must be A, B or C");
  return errs;
}

/** Per-setup numbers for review.md. Rates are null when no mature session supports them. */
export interface SetupSummary {
  setup_id: string;
  label: string;
  sessions: number;
  mature: number;
  spend_usd: number;
  unpriced: number;
  /** Mean survival over mature sessions. */
  survival: number | null;
  /** Share of mature sessions that were reverted. */
  reverted: number | null;
  /** Mean human rework share over mature sessions. */
  rework_human: number | null;
  /** Share of mature sessions that needed exactly one user prompt. */
  unattended: number | null;
}

const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Groups sessions by setup_id. Sessions with no setup are left out; the caller counts them. */
export function summarizeSetups(sessions: Session[], outcomes: Outcome[]): SetupSummary[] {
  const byId = new Map<string, Outcome>(outcomes.map((o) => [o.session_id, o]));
  const groups = new Map<string, Session[]>();
  for (const s of sessions) {
    if (s.setup_id === null) continue;
    (groups.get(s.setup_id) ?? groups.set(s.setup_id, []).get(s.setup_id)!).push(s);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([setup_id, group]) => {
      const outs = group.map((s) => byId.get(s.id)).filter((o): o is Outcome => o?.status === "mature");
      const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
      const survival = outs.map((o) => o.survival).filter((x): x is number => x !== null);
      const reverted = outs.map((o) => o.reverted).filter((x): x is boolean => x !== null);
      const human = outs.map((o) => o.rework_human).filter((x): x is number => x !== null);
      const unattended = outs.map((o) => o.unattended).filter((x): x is boolean => x !== null);
      const priced = group.map((s) => s.cost_usd).filter((x): x is number => x !== null);
      const first = group[0]!;
      return {
        setup_id,
        label: `${first.harness} · ${first.model}`,
        sessions: group.length,
        mature: outs.length,
        spend_usd: sum(priced),
        unpriced: group.length - priced.length,
        survival: mean(survival),
        reverted: reverted.length === 0 ? null : reverted.filter(Boolean).length / reverted.length,
        rework_human: mean(human),
        unattended: unattended.length === 0 ? null : unattended.filter(Boolean).length / unattended.length,
      };
    });
}

export interface ReviewReport {
  review: Review;
  /** Why the label is what it is, printed under the summary. */
  note: string;
  /** Sessions with setup_id and cost_usd filled in. */
  sessions: Session[];
  outcomes: Outcome[];
  /** Bullet lines for the notes section of review.md. */
  notes: string[];
}

const pct = (x: number | null) => (x === null ? "—" : `${(100 * x).toFixed(1)}%`);
const usd = (x: number) => `$${x.toFixed(2)}`;

export function renderReviewMarkdown(report: ReviewReport): string {
  const { review, note, notes } = report;
  const rows = summarizeSetups(report.sessions, report.outcomes);
  const lines = [
    `# Review: ${review.repo}`,
    "",
    `- Review id: \`${review.id}\``,
    `- Created: ${review.created_at}`,
    `- Evidence level: ${review.evidence_level} (observational)`,
    `- Label: \`${review.label}\``,
    `- Suspect: ${review.suspect ?? "none"}`,
    "",
    note,
    "",
    "## Setups",
    "",
    "| Setup | Harness · model | Sessions | Mature | Spend | Survival | Reverted | Rework (human) | Unattended |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map(
      (r) =>
        `| \`${r.setup_id}\` | ${r.label} | ${r.sessions} | ${r.mature} | ${usd(r.spend_usd)}${r.unpriced ? ` (${r.unpriced} unpriced)` : ""} | ${pct(r.survival)} | ${pct(r.reverted)} | ${pct(r.rework_human)} | ${pct(r.unattended)} |`,
    ),
    "",
    "## Notes",
    "",
    ...(notes.length ? notes.map((n) => `- ${n}`) : ["- none"]),
    "",
  ];
  return lines.join("\n");
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

/**
 * Writes the four report files into `outDir`. Throws, and writes nothing, when review.json fails validation.
 * Returns the paths written.
 */
export function writeReview(outDir: string, report: ReviewReport): string[] {
  const problems = validateReview(report.review);
  if (problems.length) throw new Error(`review.json does not validate: ${problems.join("; ")}`);
  mkdirSync(outDir, { recursive: true });
  const files: [string, string][] = [
    ["review.json", json(report.review)],
    ["sessions.json", json(report.sessions)],
    ["outcomes.json", json(report.outcomes)],
    ["review.md", renderReviewMarkdown(report)],
  ];
  return files.map(([name, body]) => {
    const path = join(outDir, name);
    writeFileSync(path, body);
    return path;
  });
}
