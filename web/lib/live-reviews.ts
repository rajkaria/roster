// Server-side reads of live reviews (post-deadline) from rajkaria/roster-reviews, for /r/<owner>/<repo> and /api/live.
// Fresh through the contents API when ROSTER_DISPATCH_TOKEN is set, else from GitHub's raw CDN. Never through Next's
// data cache: it kept serving a "not found" for index.json that it had cached at build time, before the worker repo
// existed. Callers cache whole responses instead (s-maxage on /api/live).
import { github, slugOf, workerFile, type Gh, type LiveStatus } from "./live";
import { normalize } from "./reviews";
import type { Review } from "./types";

export interface LiveIndexEntry {
  repo: string;
  slug: string;
  href: string;
  outcome: "ok" | "no_entire_data" | "failed";
  generated_at: string | null;
  finished_at: string | null;
  run_url: string | null;
  label: string | null;
  sessions: number;
  mature_sessions: number;
  setups: {
    setup_id: string;
    label: string | null;
    harness: string | null;
    model: string | null;
    sessions: number;
    mature_sessions: number;
    spend_usd: number | null;
    survival: number | null;
    cost_per_surviving_change: number | null;
  }[];
}

export interface LiveReview {
  review: Review;
  status: LiveStatus | null;
  outcomes: { session_id: string; tercile: number | null }[];
}

function source(): { gh?: Gh; init: RequestInit } {
  const token = process.env.ROSTER_DISPATCH_TOKEN?.trim();
  return { ...(token ? { gh: github(token) } : {}), init: { cache: "no-store" } };
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const text = await workerFile(path, source());
    return text === null ? null : (JSON.parse(text) as T);
  } catch {
    return null;
  }
}

/** Every live review the worker has published, newest first. Empty when the index cannot be read. */
export async function loadLiveIndex(): Promise<LiveIndexEntry[]> {
  const idx = await readJson<{ reviews?: LiveIndexEntry[] }>("index.json");
  return Array.isArray(idx?.reviews) ? idx.reviews : [];
}

/**
 * The live review of owner/repo, or null. GitHub names are case-insensitive but the worker's directories use the
 * canonical name, so a miss on the exact slug looks the repo up in the index.
 */
export async function loadLiveReview(owner: string, repo: string): Promise<LiveReview | null> {
  let slug = slugOf(`${owner}/${repo}`);
  let raw = await readJson<unknown>(`reviews/${slug}/review.json`);
  if (raw === null) {
    const hit = (await loadLiveIndex()).find((e) => e.outcome === "ok" && e.repo.toLowerCase() === `${owner}/${repo}`.toLowerCase());
    if (!hit) return null;
    slug = hit.slug;
    raw = await readJson<unknown>(`reviews/${slug}/review.json`);
  }
  const review = normalize(raw);
  if (!review) return null;
  const [status, outcomes] = await Promise.all([
    readJson<LiveStatus>(`reviews/${slug}/status.json`),
    readJson<unknown>(`reviews/${slug}/outcomes.json`),
  ]);
  return {
    review,
    status,
    outcomes: Array.isArray(outcomes) ? (outcomes as LiveReview["outcomes"]) : [],
  };
}
