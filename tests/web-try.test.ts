// F17: the paste-a-repo helpers and the /api/review route.
// The cached case copies the real published review (reports/rajkaria__roster/review.json) to the cache path
// the route reads; request bodies are built inline, nothing is invented as a fixture.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { POST } from "../web/app/api/review/route.ts";
import { createLimiter, parseRepoUrl } from "../web/lib/try.ts";

const ROOT = join(import.meta.dir, "..");
// The route resolves its cache path against process.cwd(), so the test writes where the route looks.
const CACHE_ROOT = join(process.cwd(), "public", "data", "r");

let seq = 0;
/** A unique owner/repo per test run, always within GitHub's allowed characters. */
function uniq(): string {
  return `f17-${Date.now().toString(36)}-${(seq++).toString(36)}`;
}

function makeRequest(repo: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/review", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ repo }),
  });
}

function putReview(owner: string, repo: string): string {
  const dir = join(CACHE_ROOT, owner, repo);
  mkdirSync(dir, { recursive: true });
  const real = JSON.parse(readFileSync(join(ROOT, "reports", "rajkaria__roster", "review.json"), "utf8")) as object;
  writeFileSync(join(dir, "review.json"), JSON.stringify({ ...real, repo: `${owner}/${repo}` }));
  return dir;
}

/** Removes the owner's cache dir and the empty parents the test created, leaving the repo root as it was. */
function clean(owner: string): void {
  rmSync(join(CACHE_ROOT, owner), { recursive: true, force: true });
  for (const dir of [CACHE_ROOT, join(process.cwd(), "public", "data"), join(process.cwd(), "public")]) {
    try {
      rmdirSync(dir);
    } catch {
      // Absent, or still holding another run's data: leave it.
    }
  }
}

describe("parseRepoUrl", () => {
  const valid: [string, { owner: string; repo: string }][] = [
    ["https://github.com/owner/repo", { owner: "owner", repo: "repo" }],
    ["https://github.com/owner/repo.git", { owner: "owner", repo: "repo" }],
    ["https://github.com/owner/repo/", { owner: "owner", repo: "repo" }],
    ["https://github.com/owner/repo.git/", { owner: "owner", repo: "repo" }],
    ["https://github.com/owner/repo.name", { owner: "owner", repo: "repo.name" }],
    ["https://github.com/my-org/my_repo.v2", { owner: "my-org", repo: "my_repo.v2" }],
    ["owner/repo", { owner: "owner", repo: "repo" }],
    ["owner/repo.git", { owner: "owner", repo: "repo" }],
    ["  owner/repo  ", { owner: "owner", repo: "repo" }],
  ];

  test.each(valid)("accepts %s", (input, expected) => {
    expect(parseRepoUrl(input)).toEqual(expected);
  });

  const invalid = [
    "https://gitlab.com/owner/repo",
    "http://github.com/owner/repo",
    "ftp://github.com/owner/repo",
    "https://github.com.evil.com/owner/repo",
    "https://user:pass@github.com/owner/repo",
    "https://github.com/owner/repo/issues",
    "https://github.com/owner/repo.git/extra",
    "https://github.com/owner",
    "https://github.com",
    "https://github.com/owner/repo$",
    "https://github.com/owner/repo with space",
    "https://github.com/owner/re po",
    "https://github.com/-owner/repo",
    "https://github.com/owner-/repo",
    "https://github.com/owner/.git",
    "https://github.com/owner/..",
    "https://github.com/owner/repo?x=1",
    "https://github.com/owner/repo#x",
    "github.com/owner/repo",
    "owner/repo/extra",
    "owner/repo/",
    "owner",
    "",
    "   ",
  ];

  test.each(invalid)("rejects %j", (input) => {
    expect(parseRepoUrl(input)).toBeNull();
  });
});

describe("createLimiter", () => {
  test("allows perMinute takes, then holds the key until the window refills", () => {
    const limiter = createLimiter({ perMinute: 2 });
    // Budget spent at t=1000: 0.033 tokens left, refilling at 2 per minute from there.
    expect(limiter.take("a", 0)).toBe(true);
    expect(limiter.take("a", 1_000)).toBe(true);
    expect(limiter.take("a", 2_000)).toBe(false);
    expect(limiter.take("a", 3_000)).toBe(false);
    // A full minute after the last take the bucket is full again.
    expect(limiter.take("a", 61_000)).toBe(true);
    expect(limiter.take("a", 61_001)).toBe(true);
    expect(limiter.take("a", 61_002)).toBe(false);
  });

  test("tracks keys independently", () => {
    const limiter = createLimiter({ perMinute: 1 });
    expect(limiter.take("a", 0)).toBe(true);
    expect(limiter.take("b", 500)).toBe(true);
    expect(limiter.take("a", 0)).toBe(false);
    expect(limiter.take("b", 500)).toBe(false);
  });

  test("a partial refill is not a whole token", () => {
    const limiter = createLimiter({ perMinute: 1 });
    expect(limiter.take("a", 0)).toBe(true);
    expect(limiter.take("a", 30_000)).toBe(false);
    expect(limiter.take("a", 61_000)).toBe(true);
  });

  test("a key first seen later starts with a full budget", () => {
    const limiter = createLimiter({ perMinute: 1 });
    limiter.take("a", 0);
    expect(limiter.take("b", 30_000)).toBe(true);
  });

  test("a zero budget never lets a key through", () => {
    const limiter = createLimiter({ perMinute: 0 });
    expect(limiter.take("a", 0)).toBe(false);
    expect(limiter.take("a", 60_000)).toBe(false);
  });

  test("a clock that stands still or moves backwards grants nothing extra", () => {
    const limiter = createLimiter({ perMinute: 1 });
    expect(limiter.take("a", 5_000)).toBe(true);
    expect(limiter.take("a", 5_000)).toBe(false);
    expect(limiter.take("a", 4_000)).toBe(false);
  });
});

describe("POST /api/review", () => {
  test("400s an invalid paste, a missing repo and a non-string repo", async () => {
    expect((await POST(makeRequest("https://gitlab.com/owner/repo"))).status).toBe(400);
    expect((await POST(makeRequest("not-a-repo"))).status).toBe(400);
    expect((await POST(makeRequest(undefined))).status).toBe(400);
    expect((await POST(makeRequest(42))).status).toBe(400);
    const noJson = new Request("http://localhost/api/review", { method: "POST", body: "{" });
    expect((await POST(noJson)).status).toBe(400);
  });

  test("202s {queued: true} for a repo with no cached review", async () => {
    const owner = uniq();
    const repo = uniq();
    const res = await POST(makeRequest(`${owner}/${repo}`));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: true });
  });

  test("200s {cached: true, path} when the cache holds a review", async () => {
    const owner = uniq();
    const repo = uniq();
    putReview(owner, repo);
    try {
      const res = await POST(makeRequest(`https://github.com/${owner}/${repo}.git/`));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ cached: true, path: `public/data/r/${owner}/${repo}/review.json` });
    } finally {
      clean(owner);
    }
  });

  test("429s a client that spends its budget and leaves other clients alone", async () => {
    const owner = uniq();
    const repo = uniq();
    const client = `f17-burst-${uniq()}`;
    const other = `f17-other-${uniq()}`;

    let allowed = 0;
    let blocked: Response | null = null;
    for (let i = 0; i < 200; i++) {
      const res = await POST(makeRequest(`${owner}/${repo}`, { "x-forwarded-for": client }));
      if (res.status === 429) {
        blocked = res;
        break;
      }
      expect(res.status).toBe(202);
      allowed++;
    }

    expect(allowed).toBeGreaterThan(0);
    expect(blocked).not.toBeNull();
    expect(blocked!.headers.get("retry-after")).toBeTruthy();
    expect(await blocked!.json()).toEqual({ error: "too many requests" });

    const fresh = await POST(makeRequest(`${owner}/${repo}`, { "x-forwarded-for": other }));
    expect(fresh.status).toBe(202);
  });
});
