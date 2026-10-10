// DESIGN.md §"Score: reverted, rework". A change counts as reverted when a later commit says
// `This reverts commit <sha>`, or when at least half of its added lines are deleted within the window.

import { DEFAULT_WINDOW, trackLines, type Tracked } from "./rework.ts";

export const REVERT_SHARE = 0.5;

export function reverted(repo: string, sha: string, window: number = DEFAULT_WINDOW): boolean {
  return isReverted(trackLines(repo, sha, window));
}

/** The revert verdict from tracked lines, so one `trackMany` pass serves both rework and reverted. */
export function isReverted(t: Tracked): boolean {
  if (t.explicitRevert) return true;
  return t.added > 0 && t.matchedHuman + t.matchedAgent >= REVERT_SHARE * t.added;
}
