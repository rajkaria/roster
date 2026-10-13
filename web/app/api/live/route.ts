// GET /api/live: the live-review index (post-deadline), for the table on /r. /r itself stays static and fetches
// this from the browser, so the frozen reviews it lists are never re-rendered.
import { loadLiveIndex } from "../../../lib/live-reviews";

// Rendered per request and cached by the CDN for 30 s (the cache-control below), not by Next.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const reviews = (await loadLiveIndex()).filter((r) => r.outcome === "ok");
  return new Response(JSON.stringify({ reviews }), {
    headers: { "content-type": "application/json", "cache-control": "public, s-maxage=30, stale-while-revalidate=60" },
  });
}
