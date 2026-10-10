import { describe, test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { parseRepoUrl, createLimiter } from "../../web/lib/try.ts";
import { POST } from "../../web/app/api/review/route.ts";

describe("parseRepoUrl", () => {
  const valid = [
    {
      input: "https://github.com/owner/repo",
      expected: { owner: "owner", repo: "repo" },
    },
    {
      input: "https://github.com/owner/repo.git",
      expected: { owner: "owner", repo: "repo" },
    },
    {
      input: "https://github.com/owner/repo/",
      expected: { owner: "owner", repo: "repo" },
    },
    {
      input: "https://github.com/owner/repo.git/",
      expected: { owner: "owner", repo: "repo" },
    },
    {
      input: "owner/repo",
      expected: { owner: "owner", repo: "repo" },
    },
    {
      input: "https://github.com/owner/repo.name",
      expected: { owner: "owner", repo: "repo.name" },
    },
  ];

  for (const { input, expected } of valid) {
    test(`accepts ${input}`, () => {
      expect(parseRepoUrl(input)).toEqual(expected);
    });
  }

  const invalid = [
    "https://gitlab.com/owner/repo",
    "https://github.com/owner/repo/issues",
    "https://github.com/owner/repo.git/extra",
    "https://github.com/owner",
    "https://github.com/owner/repo$",
    "https://github.com/owner/repo with space",
    "https://github.com.evil.com/owner/repo",
    "https://github.com/owner/repo?x=1",
    "https://github.com/owner/repo#x",
    "owner/repo/extra",
    "owner",
    "",
  ];

  for (const input of invalid) {
    test(`rejects ${input || "<empty>"}`, () => {
      expect(parseRepoUrl(input)).toBeNull();
    });
  }
});

describe("createLimiter", () => {
  test("allows up to perMinute requests per key in a minute", () => {
    const limiter = createLimiter({ perMinute: 2 });

    expect(limiter.take("a", 0)).toBe(true);
    expect(limiter.take("a", 1_000)).toBe(true);
    expect(limiter.take("a", 2_000)).toBe(false);
  });

  test("tracks keys independently", () => {
    const limiter = createLimiter({ perMinute: 1 });

    expect(limiter.take("a", 0)).toBe(true);
    expect(limiter.take("b", 0)).toBe(true);
    expect(limiter.take("a", 0)).toBe(false);
  });

  test("refills after a minute", () => {
    const limiter = createLimiter({ perMinute: 2 });

    expect(limiter.take("a", 0)).toBe(true);
    expect(limiter.take("a", 1_000)).toBe(true);

    expect(limiter.take("a", 61_000)).toBe(true);
    expect(limiter.take("a", 61_001)).toBe(true);
    expect(limiter.take("a", 61_002)).toBe(false);
  });
});

function makeRequest(repo: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/review", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ repo }),
  });
}

describe("POST /api/review", () => {
  test("returns 400 for an invalid repo URL", async () => {
    const res = await POST(makeRequest("https://gitlab.com/owner/repo"));
    expect(res.status).toBe(400);
  });

  test("returns 202 queued when no cached review exists", async () => {
    const owner = `f17owner${Date.now()}`;
    const repo = `f17repo${Date.now()}`;

    const res = await POST(makeRequest(`${owner}/${repo}`));

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ queued: true });
  });

  test("returns 200 cached when review.json exists", async () => {
    const owner = `f17owner${Date.now()}`;
    const repo = `f17repo${Date.now()}`;
    const dir = path.join(process.cwd(), "public", "data", "r", owner, repo);

    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "review.json"), "{}");

    try {
      const res = await POST(makeRequest(`${owner}/${repo}`));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        cached: true,
        path: `public/data/r/${owner}/${repo}/review.json`,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns 429 when rate limited", async () => {
    const owner = `f17limit${Date.now()}`;
    const repo = `f17limitrepo${Date.now()}`;
    const headers = { "x-forwarded-for": `acceptance-${Date.now()}` };

    let status = 0;
    for (let i = 0; i < 2_000; i++) {
      const res = await POST(makeRequest(`${owner}/${repo}`, headers));
      status = res.status;
      if (status === 429) break;
    }

    expect(status).toBe(429);
  });
});
