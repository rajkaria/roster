export type OptIn = { repo: string; public: boolean; prAllowed: boolean; replyUrl?: string };

const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

function httpsUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  try {
    return new URL(v).protocol === "https:" ? v : undefined;
  } catch {
    return undefined;
  }
}

export function loadOptIns(json: unknown): OptIn[] {
  if (!Array.isArray(json)) return [];
  const out: OptIn[] = [];
  for (const e of json) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    if (typeof r.repo !== "string" || !REPO_RE.test(r.repo.trim())) continue;
    if (typeof r.public !== "boolean" || typeof r.prAllowed !== "boolean") continue;
    const entry: OptIn = { repo: r.repo.trim(), public: r.public, prAllowed: r.prAllowed };
    const url = httpsUrl(r.replyUrl);
    if (url) entry.replyUrl = url;
    out.push(entry);
  }
  return out;
}

export function isAllowed(
  optIns: ReturnType<typeof loadOptIns>,
  repo: string,
  action: "review-public" | "open-pr",
): boolean {
  const key = repo.trim().toLowerCase();
  const matches = optIns.filter((o) => o.repo.toLowerCase() === key);
  if (matches.length === 0) return false;
  return matches.some((o) => (action === "review-public" ? o.public === true : o.prAllowed === true));
}
