// Data for the landing page's graphics: the scoreboard, the task grid, the cost chart and the roster cards.
// Every number they draw comes from the published report files under public/data (copied from reports/).
// Each builder is pure over parsed JSON, so tests feed it the real files and altered copies; the *File helpers
// do the disk reads and are what the page uses.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadForward, type ForwardRow } from "./forward";
import type { Review, SetupRow } from "./types";
import { FORWARD_SETUPS, type Outcome, type TaskCell } from "./landing-shared";

export { FORWARD_SETUPS, usd3, type Outcome, type TaskCell } from "./landing-shared";

const DATA = join(process.cwd(), "public", "data");

export interface CostPair {
  task: string;
  old: number;
  new: number;
}

export interface CostSummary {
  pairs: number;
  cheaperNew: number;
  medianNew: number;
  medianOld: number;
  p: number;
}

export interface TaskGrid {
  /** Every frozen task, valid or excluded, in task-number order. */
  cells: TaskCell[];
  counts: Record<Outcome, number>;
  /** Valid pairs priced on both sides, most expensive old run first. */
  costPairs: CostPair[];
  /** The published cost summary (forward-cost.json), or null when absent or malformed. */
  cost: CostSummary | null;
}

const object = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

interface Exclusion {
  task: string;
  reason: string;
  amendment?: number;
}

/** Well-formed entries of forward-exclusions.json. Anything else is ignored, never guessed at. */
export function parseExclusions(json: unknown): Exclusion[] {
  const list = object(json)?.exclusions;
  if (!Array.isArray(list)) return [];
  const out: Exclusion[] = [];
  for (const raw of list) {
    const e = object(raw);
    if (!e || typeof e.task !== "string" || typeof e.reason !== "string") continue;
    out.push(finite(e.amendment) ? { task: e.task, reason: e.reason, amendment: e.amendment } : { task: e.task, reason: e.reason });
  }
  return out;
}

function outcomeOf(r: ForwardRow): Outcome {
  if (r.new && r.old) return "both";
  if (r.new) return "newOnly";
  if (r.old) return "oldOnly";
  return "neither";
}

/** "F07" sorts before "F10": by the number in the id, then by the id itself. */
const taskOrder = (a: string, b: string): number => {
  const na = Number(/\d+/.exec(a)?.[0] ?? NaN);
  const nb = Number(/\d+/.exec(b)?.[0] ?? NaN);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a.localeCompare(b);
};

/** "Only F11 was dropped for a network outage" becomes a short tooltip; the full text stays on /experiment. */
export function shortReason(reason: string): string {
  const r = reason.replace(/^F\d+:\s*/, "");
  if (/network outage/i.test(r)) return "network outage, excluded for both sides";
  if (/inherited base test/i.test(r)) return "both sides failed only on a test inherited from the base commit";
  return r;
}

function costSummary(json: unknown): CostSummary | null {
  const c = object(json);
  if (!c) return null;
  const { pairs, cheaperNew, medianNewUsd, medianOldUsd, wilcoxonP } = c;
  if (!finite(pairs) || !finite(cheaperNew) || !finite(medianNewUsd) || !finite(medianOldUsd) || !finite(wilcoxonP)) return null;
  return { pairs, cheaperNew, medianNew: medianNewUsd, medianOld: medianOldUsd, p: wilcoxonP };
}

/**
 * Builds the grid from forward.json, forward-exclusions.json and forward-cost.json. A task excluded before pairing
 * (no row) still gets a cell, so the grid always shows the whole frozen backlog.
 */
export function taskGrid(forwardJson: unknown, exclusionsJson: unknown, costJson: unknown): TaskGrid {
  const { rows } = loadForward(forwardJson);
  const exclusions = new Map(parseExclusions(exclusionsJson).map((e) => [e.task, e]));
  const cells: TaskCell[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.task)) continue;
    seen.add(r.task);
    const ex = exclusions.get(r.task);
    const reason = ex?.reason ?? r.excluded;
    if (reason !== undefined) {
      cells.push({ task: r.task, outcome: "excluded", costOld: r.costOld, costNew: r.costNew, reason: shortReason(reason), ...(ex?.amendment !== undefined ? { amendment: ex.amendment } : {}) });
    } else {
      cells.push({ task: r.task, outcome: outcomeOf(r), costOld: r.costOld, costNew: r.costNew });
    }
  }
  for (const ex of exclusions.values()) {
    if (seen.has(ex.task)) continue;
    seen.add(ex.task);
    cells.push({ task: ex.task, outcome: "excluded", costOld: null, costNew: null, reason: shortReason(ex.reason), ...(ex.amendment !== undefined ? { amendment: ex.amendment } : {}) });
  }
  cells.sort((a, b) => taskOrder(a.task, b.task));

  const counts: Record<Outcome, number> = { newOnly: 0, oldOnly: 0, both: 0, neither: 0, excluded: 0 };
  for (const c of cells) counts[c.outcome]++;

  const costPairs = cells
    .filter((c): c is TaskCell & { costOld: number; costNew: number } => c.outcome !== "excluded" && c.costOld !== null && c.costNew !== null)
    .map((c) => ({ task: c.task, old: c.costOld, new: c.costNew }))
    .sort((a, b) => b.old - a.old || taskOrder(a.task, b.task));

  return { cells, counts, costPairs, cost: costSummary(costJson) };
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

export function taskGridFile(dataDir: string = DATA): TaskGrid {
  const self = join(dataDir, "self");
  return taskGrid(
    readJson(join(self, "forward.json")),
    readJson(join(self, "forward-exclusions.json")),
    readJson(join(self, "forward-cost.json")),
  );
}

/** Valid pairs each setup passed: the "only" count plus the pairs both passed. */
export function passedBy(counts: Record<Outcome, number>): { old: number; new: number; valid: number } {
  return {
    old: counts.oldOnly + counts.both,
    new: counts.newOnly + counts.both,
    valid: counts.newOnly + counts.oldOnly + counts.both + counts.neither,
  };
}

/** A chart axis top: the smallest multiple of `step` at or above the largest cost. */
export function axisMax(pairs: CostPair[], step: number): number {
  const top = pairs.reduce((m, p) => Math.max(m, p.old, p.new), 0);
  return top <= 0 ? step : Math.ceil(top / step - 1e-9) * step;
}

/** "claude-sonnet-5-5" reads "Sonnet 5.5"; "deepseek-flash" reads "DeepSeek Flash". Unknown ids pass through. */
export function prettyModel(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(model);
  if (m) return `${m[1]!.charAt(0).toUpperCase()}${m[1]!.slice(1)} ${m[2]}.${m[3]}`;
  if (model.startsWith("deepseek-")) {
    const rest = model.slice("deepseek-".length).split("-").map((w) => (/^v\d/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)));
    return ["DeepSeek", ...rest].join(" ");
  }
  return model;
}

export interface RosterCard {
  setup_id: string;
  model: string;
  harness: string;
  /** "rules 243fa2" when two setups share a model and differ by rules file; else null. */
  rules: string | null;
  sessions: number;
  /** This setup's share of all sessions in the review, for the bar. */
  share: number;
  costPerSurviving: number | null;
  /** True for the setup with the lowest cost per surviving change among those with mature sessions. */
  cheapest: boolean;
}

/** One card per setup in the review, in file order. */
export function rosterCards(review: Review): RosterCard[] {
  const total = review.setups.reduce((n, s) => n + s.sessions, 0);
  const priced = review.setups.filter((s) => s.mature_sessions > 0 && s.cost_per_surviving_change !== null);
  const min = priced.reduce<SetupRow | null>((m, s) => (m === null || (s.cost_per_surviving_change ?? Infinity) < (m.cost_per_surviving_change ?? Infinity) ? s : m), null);
  return review.setups.map((s) => {
    const rules = /\(rules ([0-9a-f]+)\)/.exec(s.label)?.[1];
    return {
      setup_id: s.setup_id,
      model: prettyModel(s.model),
      harness: s.harness,
      rules: rules ? `rules ${rules}` : null,
      sessions: s.sessions,
      share: total > 0 ? s.sessions / total : 0,
      costPerSurviving: s.cost_per_surviving_change,
      cheapest: min !== null && s.setup_id === min.setup_id,
    };
  });
}

/** The frozen backlog size: every recorded pair plus the tasks excluded before pairing. */
export function frozenTasks(grid: TaskGrid): number {
  return grid.cells.length;
}

/** Total sessions across a list of reviews. */
export const sumSessions = (rows: { sessions: number }[]): number => rows.reduce((n, r) => n + r.sessions, 0);

/** "12 Oct 2026, 01:59 UTC" from an ISO timestamp; anything unparseable is returned as given. */
export function formatGenerated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date}, ${time} UTC`;
}
