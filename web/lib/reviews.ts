import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Review, SetupRow } from "./types";

const DATA = join(process.cwd(), "public", "data");

function readReview(dir: string): Review | null {
  const file = join(DATA, dir, "review.json");
  if (!existsSync(file)) return null;
  try {
    return normalize(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

/**
 * Accepts a review.json as `roster review` writes it. Files that are not reviews (no repo or setups) give null.
 * Older files without mature_sessions or cost_per_surviving_change get those filled in; rows with no mature
 * session have every rate nulled so the page never shows 0% for a setup that has no scored work.
 */
function normalize(raw: unknown): Review | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Partial<Review>;
  if (typeof r.repo !== "string" || !Array.isArray(r.setups)) return null;
  const setups = r.setups.map((s): SetupRow => {
    const mature = s.mature_sessions ?? s.sessions;
    const young = mature === 0;
    return {
      ...s,
      mature_sessions: mature,
      unattended: young ? null : s.unattended,
      survival: young ? null : s.survival,
      reverted: young ? null : s.reverted,
      rework_human: young ? null : s.rework_human,
      cost_per_surviving_change: s.cost_per_surviving_change ?? null,
    };
  });
  return { ...(r as Review), setups };
}

/** True for a setup with no mature session: its rates are null and should read "too young", not 0%. */
export const isTooYoung = (s: SetupRow) => s.mature_sessions === 0;

/** Slug dirs tried in order: "_sample", "owner__repo", "owner-repo", "owner/repo". */
function candidates(owner: string, repo: string): string[] {
  const list = [`${owner}__${repo}`, `${owner}-${repo}`, join(owner, repo)];
  if (owner === "_sample" && repo === "_sample") list.unshift("_sample");
  return list;
}

export function loadReview(owner: string, repo: string): Review | null {
  for (const c of candidates(owner, repo)) {
    const r = readReview(c);
    if (r) return r;
  }
  return null;
}

export function listParams(): { owner: string; repo: string }[] {
  if (!existsSync(DATA)) return [];
  const out: { owner: string; repo: string }[] = [];
  for (const d of readdirSync(DATA, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const r = readReview(d.name);
    if (r) {
      const [owner, repo] = r.repo.split("/");
      if (owner && repo) out.push({ owner, repo });
    }
  }
  return out;
}
