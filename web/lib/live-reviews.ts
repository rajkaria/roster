// Server-side reads of live reviews (post-deadline) from rajkaria/roster-reviews, for /r/<owner>/<repo> and /api/live.
// Fresh through the contents API when ROSTER_DISPATCH_TOKEN is set, else from GitHub's raw CDN.
// Two cache modes, because the callers differ:
// - /api/live is a dynamic route handler, so it reads with no-store and the CDN caches its response for 30 s.
//   (As an ISR route it kept serving the "not found" for index.json cached at build time, before the repo existed.)
// - /r/<owner>/<repo> is a prerendered route, and Next refuses to turn one dynamic at runtime ("Page changed from
//   static to dynamic"), so live review pages read with a 30 s revalidate and become per-path ISR pages.
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

export type ReadMode = "fresh" | "revalidate";

function source(mode: ReadMode): { gh?: Gh; init: RequestInit } {
  const token = process.env.ROSTER_DISPATCH_TOKEN?.trim();
  const init = (mode === "fresh" ? { cache: "no-store" } : { next: { revalidate: 30 } }) as RequestInit;
  return { ...(token ? { gh: github(token) } : {}), init };
}

async function readJson<T>(path: string, mode: ReadMode): Promise<T | null> {
  try {
    const text = await workerFile(path, source(mode));
    return text === null ? null : (JSON.parse(text) as T);
  } catch {
    return null;
  }
}

/** Every live review the worker has published, newest first. Empty when the index cannot be read. */
export async function loadLiveIndex(mode: ReadMode = "fresh"): Promise<LiveIndexEntry[]> {
  const idx = await readJson<{ reviews?: LiveIndexEntry[] }>("index.json", mode);
  return Array.isArray(idx?.reviews) ? idx.reviews : [];
}

/**
 * The live review of owner/repo, or null. GitHub names are case-insensitive but the worker's directories use the
 * canonical name, so a miss on the exact slug looks the repo up in the index.
 */
export async function loadLiveReview(owner: string, repo: string): Promise<LiveReview | null> {
  let slug = slugOf(`${owner}/${repo}`);
  let raw = await readJson<unknown>(`reviews/${slug}/review.json`, "revalidate");
  if (raw === null) {
    const hit = (await loadLiveIndex("revalidate")).find((e) => e.outcome === "ok" && e.repo.toLowerCase() === `${owner}/${repo}`.toLowerCase());
    if (!hit) return null;
    slug = hit.slug;
    raw = await readJson<unknown>(`reviews/${slug}/review.json`, "revalidate");
  }
  const review = normalize(raw);
  if (!review) return null;
  const [status, outcomes] = await Promise.all([
    readJson<LiveStatus>(`reviews/${slug}/status.json`, "revalidate"),
    readJson<unknown>(`reviews/${slug}/outcomes.json`, "revalidate"),
  ]);
  return {
    review,
    status,
    outcomes: Array.isArray(outcomes) ? (outcomes as LiveReview["outcomes"]) : [],
  };
}
