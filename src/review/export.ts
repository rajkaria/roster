// Writes one observational review to reports/<slug>/: review.json (the Review type, validated before
// it is written), sessions.json, outcomes.json and review.md. See docs/DESIGN.md §"Data model" and §"Review".
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { inferenceAccuracy, parseTag } from "../identity/index.ts";
import { aggregateBySetup, type ScoredOutcome, sessionCostDetail, UNKNOWN_SETUP } from "../score/index.ts";
import type { EvidenceLevel, Outcome, Review, ReviewLabel, ReviewTags, Session, SetupRow } from "../types.ts";

/** Keys of the Review type in src/types.ts. Kept in step by the `satisfies Review` check in tests. */
export const REVIEW_KEYS = [
  "id",
  "repo",
  "created_at",
  "generated_at",
  "has_entire_data",
  "setups",
  "label",
  "suspect",
  "odds_ratio",
  "ci95",
  "p_value",
  "evidence_level",
] as const;

/** Keys that may be absent: `tags` is written only when sessions carry prompt tags. */
export const OPTIONAL_REVIEW_KEYS = ["tags"] as const;

export const SETUP_ROW_KEYS = [
  "setup_id",
  "label",
  "harness",
  "model",
  "rules_hash",
  "sessions",
  "mature_sessions",
  "spend_usd",
  "priced_sessions",
  "spend_lower_bound",
  "unattended",
  "survival",
  "reverted",
  "rework_human",
  "surviving_changes",
  "cost_per_surviving_change",
  "evidence_level",
] as const satisfies readonly (keyof SetupRow)[];

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

const URL_FORM = /^[a-z][a-z0-9+.-]*:\/\/|^[^/@\s]+@[^/:\s]+:/i;

/** "owner/name" from an https, ssh:// or scp-style (git@host:owner/name) remote URL; null for anything else. */
export function parseRemote(url: string): string | null {
  const u = url.trim();
  if (!URL_FORM.test(u)) return null;
  const m = /[/:]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(u);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The review's repo slug "owner/name". A URL is parsed directly. A local path uses its `origin` remote, and with
 * no remote (or one that does not parse) falls back to the directory's basename.
 */
export function repoSlug(repo: string): string {
  const direct = parseRemote(repo);
  if (direct !== null) return direct;
  const dir = resolve(repo);
  const p = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const remote = p.exitCode === 0 ? parseRemote(p.stdout.toString()) : null;
  return remote ?? basename(dir);
}

/** Directory name under reports/ for a repo slug: "owner__name", or the bare name. */
export function slugDir(slug: string): string {
  return slug.replace("/", "__").replace(/[^A-Za-z0-9._-]+/g, "-");
}

/** Directory name under reports/: "owner__name" for GitHub repos (the web app's lookup form), else the basename. */
export function reviewSlug(repo: string): string {
  return repoLabel(repo).replace("/", "__").replace(/[^A-Za-z0-9._-]+/g, "-");
}

const RATE_KEYS = ["unattended", "survival", "reverted", "rework_human"] as const;

function validateSetupRow(row: unknown, at: string): string[] {
  if (!isRecord(row)) return [`${at} must be an object`];
  const errs: string[] = [];
  for (const k of SETUP_ROW_KEYS) if (!(k in row)) errs.push(`${at} missing ${k}`);
  for (const k of Object.keys(row)) if (!(SETUP_ROW_KEYS as readonly string[]).includes(k)) errs.push(`${at} unexpected key ${k}`);
  for (const k of ["setup_id", "label", "harness", "model"] as const) {
    if (typeof row[k] !== "string" || row[k] === "") errs.push(`${at}.${k} must be a non-empty string`);
  }
  if (row.rules_hash !== null && typeof row.rules_hash !== "string") errs.push(`${at}.rules_hash must be a string or null`);
  for (const k of ["sessions", "mature_sessions"] as const) {
    if (!Number.isInteger(row[k]) || (row[k] as number) < 0) errs.push(`${at}.${k} must be a non-negative integer`);
  }
  if (isFiniteNum(row.sessions) && isFiniteNum(row.mature_sessions) && row.mature_sessions > row.sessions) {
    errs.push(`${at}.mature_sessions exceeds sessions`);
  }
  if (row.spend_usd !== null && !(isFiniteNum(row.spend_usd) && row.spend_usd >= 0)) {
    errs.push(`${at}.spend_usd must be null or a number >= 0`);
  }
  for (const k of ["priced_sessions", "surviving_changes"] as const) {
    if (!isFiniteNum(row[k]) || row[k] < 0) errs.push(`${at}.${k} must be a number >= 0`);
  }
  if (typeof row.spend_lower_bound !== "boolean") errs.push(`${at}.spend_lower_bound must be a boolean`);
  if (isFiniteNum(row.priced_sessions) && isFiniteNum(row.sessions) && row.priced_sessions > row.sessions) {
    errs.push(`${at}.priced_sessions exceeds sessions`);
  }
  if (row.cost_per_surviving_change !== null && !(isFiniteNum(row.cost_per_surviving_change) && row.cost_per_surviving_change >= 0)) {
    errs.push(`${at}.cost_per_surviving_change must be null or a number >= 0`);
  }
  for (const k of RATE_KEYS) {
    const v = row[k];
    if (v !== null && !(isFiniteNum(v) && v >= 0 && v <= 1)) errs.push(`${at}.${k} must be null or a number in [0, 1]`);
    if (row.mature_sessions === 0 && v !== null) errs.push(`${at}.${k} must be null when mature_sessions is 0`);
  }
  if (!(EVIDENCE as readonly unknown[]).includes(row.evidence_level)) errs.push(`${at}.evidence_level must be A, B or C`);
  return errs;
}

function validTags(t: unknown): boolean {
  if (!isRecord(t) || !isRecord(t.by_tag)) return false;
  if (t.tag_accuracy !== null && !(isFiniteNum(t.tag_accuracy) && t.tag_accuracy >= 0 && t.tag_accuracy <= 1)) return false;
  return Object.values(t.by_tag).every(
    (v) => isRecord(v) && Number.isInteger(v.sessions) && Array.isArray(v.setup_ids) && v.setup_ids.every((x) => typeof x === "string"),
  );
}

/** Lists every way `value` fails the Review type. An empty list means it validates. */
export function validateReview(value: unknown): string[] {
  if (!isRecord(value)) return ["review must be an object"];
  const errs: string[] = [];
  for (const k of REVIEW_KEYS) if (!(k in value)) errs.push(`missing ${k}`);
  const allowed: readonly string[] = [...REVIEW_KEYS, ...OPTIONAL_REVIEW_KEYS];
  for (const k of Object.keys(value)) if (!allowed.includes(k)) errs.push(`unexpected key ${k}`);

  for (const k of ["id", "repo", "created_at", "generated_at"] as const) {
    if (typeof value[k] !== "string" || value[k] === "") errs.push(`${k} must be a non-empty string`);
  }
  for (const k of ["created_at", "generated_at"] as const) {
    if (typeof value[k] === "string" && Number.isNaN(Date.parse(value[k]))) errs.push(`${k} is not a date`);
  }
  if (typeof value.has_entire_data !== "boolean") errs.push("has_entire_data must be a boolean");
  if (!Array.isArray(value.setups)) errs.push("setups must be an array");
  else value.setups.forEach((row, i) => errs.push(...validateSetupRow(row, `setups[${i}]`)));
  if ("tags" in value && !validTags(value.tags)) errs.push("tags must be { by_tag, tag_accuracy }");

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

/**
 * One row per known setup, built with aggregateBySetup. Sessions with no setup are left out (the review notes
 * count them). Rates are fractions of mature sessions; rework_human is the mean over mature sessions that have it.
 */
export function buildSetupRows(sessions: Session[], outcomes: Outcome[]): SetupRow[] {
  const byId = new Map<string, Outcome>(outcomes.map((o) => [o.session_id, o]));
  const scored: ScoredOutcome[] = [];
  for (const s of sessions) {
    const o = byId.get(s.id);
    if (!o || s.setup_id === null) continue;
    scored.push({
      ...o,
      setup_id: s.setup_id,
      commit_sha: s.commit_sha,
      cost_usd: s.cost_usd,
      censored: o.status === "mature" ? null : s.commit_sha === null ? "no_commit" : "too_young",
    });
  }
  const first = new Map<string, Session>();
  for (const s of sessions) if (s.setup_id !== null && !first.has(s.setup_id)) first.set(s.setup_id, s);

  return aggregateBySetup(scored)
    .filter((a) => a.setup_id !== UNKNOWN_SETUP)
    .map((a) => {
      const s = first.get(a.setup_id)!;
      const human = scored
        .filter((o) => o.setup_id === a.setup_id && o.status === "mature" && o.rework_human !== null)
        .map((o) => o.rework_human as number);
      const rate = (n: number) => (a.mature === 0 ? null : n / a.mature);
      return {
        setup_id: a.setup_id,
        label: `${s.harness} · ${s.model}`,
        harness: s.harness,
        model: s.model,
        rules_hash: s.rules_hash,
        sessions: a.sessions,
        mature_sessions: a.mature,
        spend_usd: a.cost_usd,
        priced_sessions: a.priced_sessions,
        spend_lower_bound: sessions.some(
          (x) => x.setup_id === a.setup_id && x.cost_usd !== null && sessionCostDetail({ ...x, cost_usd: null }).lower_bound,
        ),
        unattended: rate(a.unattended),
        survival: a.survival_mean,
        reverted: rate(a.reverted),
        rework_human: mean(human),
        surviving_changes: a.survival_sum,
        cost_per_surviving_change: a.cost_per_surviving_change,
        evidence_level: "A",
      };
    });
}

/** The `tags` block, or undefined when no session's first prompt carries a `[roster setup=…]` tag. */
export function buildTags(sessions: Session[]): ReviewTags | undefined {
  const tagged = sessions.map((s) => ({ setupId: s.setup_id, tag: parseTag(s.first_prompt) }));
  if (tagged.every((t) => t.tag === null)) return undefined;
  const ids = new Map<string, { sessions: number; ids: Set<string> }>();
  for (const { setupId, tag } of tagged) {
    if (tag === null) continue;
    const e = ids.get(tag.setup) ?? ids.set(tag.setup, { sessions: 0, ids: new Set() }).get(tag.setup)!;
    e.sessions++;
    if (setupId !== null) e.ids.add(setupId);
  }
  const by_tag = Object.fromEntries(
    [...ids].sort(([a], [b]) => a.localeCompare(b)).map(([tag, e]) => [tag, { sessions: e.sessions, setup_ids: [...e.ids].sort() }]),
  );
  return { by_tag, tag_accuracy: inferenceAccuracy(tagged) };
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
const spend = (r: SetupRow) =>
  r.spend_usd === null ? `unknown (${r.priced_sessions}/${r.sessions} priced)` : `${r.spend_lower_bound ? "≥ " : ""}${usd(r.spend_usd)}`;

export function renderReviewMarkdown(report: ReviewReport): string {
  const { review, note, notes } = report;
  const young = (r: SetupRow, v: string) => (r.mature_sessions === 0 ? "too young" : v);
  const lines = [
    `# Review: ${review.repo}`,
    "",
    `- Review id: \`${review.id}\``,
    `- Created: ${review.created_at}`,
    `- Entire data: ${review.has_entire_data ? "yes" : "no"}`,
    `- Evidence level: ${review.evidence_level} (observational)`,
    `- Label: \`${review.label}\``,
    `- Suspect: ${review.suspect ?? "none"}`,
    "",
    note,
    "",
    "## Setups",
    "",
    "| Setup | Harness · model | Sessions | Mature | Spend | Survival | Reverted | Rework (human) | Unattended | $/surviving change | Evidence |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |",
    ...(review.setups ?? buildSetupRows(report.sessions, report.outcomes)).map(
      (r) =>
        `| \`${r.setup_id}\` | ${r.label} | ${r.sessions} | ${r.mature_sessions} | ${spend(r)} | ${young(r, pct(r.survival))} | ${young(r, pct(r.reverted))} | ${young(r, pct(r.rework_human))} | ${young(r, pct(r.unattended))} | ${r.cost_per_surviving_change === null ? "—" : usd(r.cost_per_surviving_change)} | ${r.evidence_level} |`,
    ),
    ...(review.tags
      ? [
          "",
          "## Prompt tags",
          "",
          `Tag accuracy: ${pct(review.tags.tag_accuracy)}`,
          "",
          "| Tag | Sessions | Inferred setups |",
          "| --- | ---: | --- |",
          ...Object.entries(review.tags.by_tag).map(([t, v]) => `| \`${t}\` | ${v.sessions} | ${v.setup_ids.map((i) => `\`${i}\``).join(", ") || "—"} |`),
        ]
      : []),
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
