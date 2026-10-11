// F17: POST /api/review, the endpoint behind the public page's paste-a-repo box.
// It validates the reference, rate-limits each client, then either serves the cached review or reports the
// repo as queued. `public/data/r/<owner>/<repo>/review.json` is the path the /r/<owner>/<repo> page reads,
// relative to the web app root (process.cwd()).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createLimiter, parseRepoUrl } from "../../../lib/try";

export const runtime = "nodejs";

/** Requests one client may make per minute. */
const PER_MINUTE = 30;

const limiter = createLimiter({ perMinute: PER_MINUTE });

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

  const path = `public/data/r/${target.owner}/${target.repo}/review.json`;
  if (existsSync(join(process.cwd(), path))) return json({ cached: true, path }, 200);

  // No run has filled this repo yet. The caller polls the review path; the worker that writes it is not
  // part of this route.
  return json({ queued: true }, 202);
}
