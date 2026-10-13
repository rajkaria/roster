// F17: POST /api/review, the endpoint behind the public page's paste-a-repo box.
// It validates the reference, rate-limits each client, then either serves the cached review or reports the
// repo as queued. Post-deadline (13 Oct): with ROSTER_DISPATCH_TOKEN set, "queued" means a live review really
// starts (lib/live.ts dispatches a run in rajkaria/roster-reviews), and GET /api/review?job=&repo= reports on it.
// Without the token the route behaves as it did at submission. Published reviews live at `public/data/<owner>__<repo>/review.json`, the directory the
// /r/<owner>/<repo> page reads (the older `public/data/r/<owner>/<repo>/review.json` is still accepted). On Vercel,
// public/ is served by the CDN but is not in the function bundle, so the route also asks its own origin for the file.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { github, JOB_RE, jobStatus, requestReview } from "../../../lib/live";
import { createLimiter, parseRepoUrl } from "../../../lib/try";

export const runtime = "nodejs";

/** Requests one client may make per minute. */
const PER_MINUTE = 30;

const limiter = createLimiter({ perMinute: PER_MINUTE });
/** Status polls one client may make per minute: the page polls every 3 s. */
const POLLS_PER_MINUTE = 40;
const pollLimiter = createLimiter({ perMinute: POLLS_PER_MINUTE });

/** The GitHub token that may dispatch live reviews, or null when live reviews are off. */
function dispatchToken(): string | null {
  return process.env.ROSTER_DISPATCH_TOKEN?.trim() || null;
}

/** Behind a proxy the caller is the first hop in x-forwarded-for; direct calls fall back to x-real-ip. */
function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Candidate review paths, relative to the web app root: the published slug (as typed, then lowercased), then the older layout. */
function candidates(owner: string, repo: string): string[] {
  const slugs = [...new Set([`${owner}__${repo}`, `${owner}__${repo}`.toLowerCase()])];
  return [...slugs.map((s) => `public/data/${s}/review.json`), `public/data/r/${owner}/${repo}/review.json`];
}

/** The published review's path, from disk when public/ is there, else from a HEAD on this origin's static file. */
async function publishedReview(owner: string, repo: string, requestUrl: string): Promise<string | null> {
  const paths = candidates(owner, repo);
  const onDisk = paths.find((p) => existsSync(join(process.cwd(), p)));
  if (onDisk) return onDisk;
  for (const p of paths.slice(0, -1)) {
    try {
      const res = await fetch(new URL(p.slice("public".length), requestUrl), { method: "HEAD", signal: AbortSignal.timeout(3000) });
      if (res.ok) return p;
    } catch {
      // Unreachable origin (tests, local runs without a server): fall through to queued.
    }
  }
  return null;
}

export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }
  const repo = typeof payload === "object" && payload !== null ? (payload as { repo?: unknown }).repo : undefined;
  if (typeof repo !== "string") return json({ error: "body must be {repo: string}" }, 400);

  const target = parseRepoUrl(repo);
  if (!target) return json({ error: "not a GitHub repository reference" }, 400);

  // Checked after validation, so a malformed paste never spends the caller's budget.
  if (!limiter.take(clientKey(request), Date.now())) {
    return json({ error: "too many requests" }, 429, { "retry-after": String(PER_MINUTE) });
  }

  const token = dispatchToken();
  if (!token) {
    const path = await publishedReview(target.owner, target.repo, request.url);
    if (path) return json({ cached: true, path }, 200);
    // Live reviews are off: nothing is started, and the page says how to run it yourself.
    return json({ queued: true }, 202);
  }

  try {
    const reply = await requestReview(
      {
        gh: github(token),
        frozen: async (o, r) => (await publishedReview(o, r, request.url)) !== null,
        newJob: () => crypto.randomUUID(),
        now: () => new Date(),
      },
      target.owner,
      target.repo,
    );
    return json(reply.body, reply.status);
  } catch {
    return json({ error: "github_unreachable", message: "Could not reach GitHub. Nothing was run." }, 502);
  }
}

/** GET /api/review?job=<id>&repo=<owner/name>: where a live review run is. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const job = url.searchParams.get("job") ?? "";
  const target = parseRepoUrl(url.searchParams.get("repo") ?? "");
  if (!JOB_RE.test(job) || !target) return json({ error: "needs ?job=<id>&repo=<owner/name>" }, 400);
  if (!pollLimiter.take(clientKey(request), Date.now())) {
    return json({ error: "too many requests" }, 429, { "retry-after": "10" });
  }
  const token = dispatchToken();
  if (!token) return json({ error: "live_off", message: "Live reviews are not switched on." }, 503);
  try {
    const reply = await jobStatus({ gh: github(token) }, job, `${target.owner}/${target.repo}`);
    return json(reply.body, reply.status, { "cache-control": "no-store" });
  } catch {
    return json({ error: "github_unreachable", message: "Could not reach GitHub." }, 502);
  }
}
