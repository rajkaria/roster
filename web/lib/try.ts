// F17: helpers behind the public page's paste-a-repo box.
// Pure functions with no Next.js imports, so the route stays a thin wrapper and tests can call them directly.

export interface RepoRef {
  owner: string;
  repo: string;
}

/** A GitHub owner login: letters, digits and hyphens, and never a leading or trailing hyphen. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/** A GitHub repository name: letters, digits, `-`, `_` and `.`. */
const REPO_NAME = /^[A-Za-z0-9._-]+$/;

/** Both names must be valid; a trailing `.git` is a clone-URL suffix, not part of the name we look up. */
function ref(owner: string | undefined, repo: string | undefined): RepoRef | null {
  if (!owner || !repo) return null;
  if (!OWNER.test(owner)) return null;
  const name = repo.replace(/\.git$/, "");
  // `.` and `..` are not repository names, and the suffix strip can leave nothing behind.
  if (!REPO_NAME.test(name) || /^\.+$/.test(name)) return null;
  return { owner, repo: name };
}

/**
 * Reads a pasted repository reference. Accepts `https://github.com/<owner>/<repo>` with an optional `.git`
 * and an optional trailing slash, or a bare `<owner>/<repo>`.
 * Returns null for any other host, scheme, extra path segment, query, fragment, or name GitHub would not allow.
 */
export function parseRepoUrl(input: string): RepoRef | null {
  const raw = input.trim();
  if (!raw) return null;

  if (!raw.includes("://")) {
    const parts = raw.split("/");
    return parts.length === 2 ? ref(parts[0], parts[1]) : null;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const segments = url.pathname.split("/").filter((s) => s !== "");
  return segments.length === 2 ? ref(segments[0], segments[1]) : null;
}

export interface Limiter {
  /** True when the key may proceed at `now` (epoch ms), false when its budget is spent. */
  take(key: string, now: number): boolean;
}

const WINDOW_MS = 60_000;
/** Keys tracked before the oldest are dropped. A per-minute window needs far fewer live keys than this. */
const MAX_KEYS = 10_000;

interface Bucket {
  tokens: number;
  /** Time of the last refill, so refills stay lazy and no timer is needed. */
  last: number;
}

/** A bucket that has sat idle long enough to refill fully is indistinguishable from an absent one. */
function forgetStale(buckets: Map<string, Bucket>, now: number): void {
  if (buckets.size <= MAX_KEYS) return;
  for (const [key, b] of buckets) {
    if (now - b.last > WINDOW_MS) buckets.delete(key);
  }
  if (buckets.size <= MAX_KEYS) return;
  const byAge = [...buckets.entries()].sort((a, b) => a[1].last - b[1].last);
  for (const [key] of byAge.slice(0, buckets.size - MAX_KEYS)) buckets.delete(key);
}

/**
 * A per-key token bucket: `perMinute` tokens, refilled continuously at perMinute per minute. `now` is
 * supplied by the caller so tests are deterministic. A first take starts the key with a full budget.
 */
export function createLimiter(opts: { perMinute: number }): Limiter {
  const capacity = Math.max(0, opts.perMinute);
  const perMs = capacity / WINDOW_MS;
  const buckets = new Map<string, Bucket>();

  return {
    take(key: string, now: number): boolean {
      let b = buckets.get(key);
      if (!b) {
        b = { tokens: capacity, last: now };
        buckets.set(key, b);
      }
      const elapsed = now - b.last;
      if (elapsed > 0) {
        b.tokens = Math.min(capacity, b.tokens + elapsed * perMs);
        b.last = now;
      }
      if (b.tokens < 1) return false;
      b.tokens -= 1;
      forgetStale(buckets, now);
      return true;
    },
  };
}
