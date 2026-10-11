// T80: loaders for the landing page's "The result" section. Everything shown comes from the published report files:
// self/forward.json (the pre-registered forward test), self/review-1/decisions.json (v1) and
// self/review-1b/decision.json (the same tasks under the v2 gate). Each loader is pure over parsed JSON.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ForwardResult {
  wording: string;
  n: number;
  newOnly: number;
  oldOnly: number;
  both: number;
  neither: number;
  p: number;
}

/** One gate call: the verdict string and the reasons exactly as the file gives them. */
export interface GateCall {
  verdict: string;
  reasons: string[];
  hiddenPass?: { incumbent: number; candidate: number };
}

export interface Result {
  forward: ForwardResult | null;
  v1: GateCall | null;
  v2: GateCall | null;
}

const DATA = join(process.cwd(), "public", "data");

const object = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function forward(json: unknown): ForwardResult | null {
  const s = object(object(json)?.summary);
  if (!s || typeof s.wording !== "string") return null;
  const { n, newOnly, oldOnly, both, neither, p } = s;
  if (!num(n) || !num(newOnly) || !num(oldOnly) || !num(both) || !num(neither) || !num(p)) return null;
  return { wording: s.wording, n, newOnly, oldOnly, both, neither, p };
}

function v1(json: unknown): GateCall | null {
  const root = object(json);
  const d = object(Array.isArray(root?.decisions) ? root.decisions[0] : null);
  if (!d || typeof d.verdict !== "string") return null;
  return { verdict: d.verdict, reasons: strings(d.reasons) };
}

function v2(json: unknown): GateCall | null {
  const d = object(json);
  if (!d || typeof d.verdict !== "string") return null;
  const out: GateCall = { verdict: d.verdict, reasons: strings(d.reasons) };
  const h = object(d.hidden_pass);
  if (h && num(h.incumbent) && num(h.candidate)) out.hiddenPass = { incumbent: h.incumbent, candidate: h.candidate };
  return out;
}

/** Builds the section's data from the three parsed files. Any missing or malformed file gives null for its part. */
export function loadResult(forwardJson: unknown, review1Json: unknown, review1bJson: unknown): Result {
  return { forward: forward(forwardJson), v1: v1(review1Json), v2: v2(review1bJson) };
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** The section's data from the files under dataDir (default public/data). */
export function loadResultFile(dataDir: string = DATA): Result {
  const self = join(dataDir, "self");
  return loadResult(
    readJson(join(self, "forward.json")),
    readJson(join(self, "review-1", "decisions.json")),
    readJson(join(self, "review-1b", "decision.json")),
  );
}
