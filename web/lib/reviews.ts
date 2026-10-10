import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Review } from "./types";

const DATA = join(process.cwd(), "public", "data");

function readReview(dir: string): Review | null {
  const file = join(DATA, dir, "review.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Review;
  } catch {
    return null;
  }
}

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
