// Live /try (post-deadline): every branch of the paste decision and the job-status mapping, against a fake GitHub.
import { describe, expect, test } from "bun:test";
import {
  DAILY_CAP,
  type Deps,
  github,
  jobOf,
  jobStatus,
  repoOf,
  requestReview,
  runTitle,
  SIZE_CAP_KB,
  slugOf,
  stageOf,
  WORKER_REPO,
} from "../web/lib/live.ts";

type Handler = (url: URL, init: RequestInit) => Response | undefined;

/** A fake api.github.com: the first handler that answers wins, anything else is a 404. Every call is recorded. */
function fakeGitHub(...handlers: Handler[]) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const fetchImpl = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    calls.push({ method: init.method ?? "GET", path: url.pathname + url.search, body: init.body ? JSON.parse(String(init.body)) : undefined });
    for (const h of handlers) {
      const res = h(url, init);
      if (res) return res;
    }
    return new Response("{}", { status: 404 });
  };
  return { gh: github("t", fetchImpl), calls };
}

const ok = (v: unknown) => new Response(typeof v === "string" ? v : JSON.stringify(v), { status: 200 });
const at = (path: string, v: unknown, method = "GET"): Handler => (url, init) =>
  url.pathname === path && (init.method ?? "GET") === method ? (typeof v === "function" ? (v as () => Response)() : ok(v)) : undefined;

const REPO = { full_name: "Octo/Cat", private: false, size: 1200, default_branch: "main" };
const repoInfo = at("/repos/octo/cat", REPO);
const cpBranch = at("/repos/Octo/Cat/branches/entire%2Fcheckpoints%2Fv1", { commit: { sha: "cp1" } });
const mainHead = at("/repos/Octo/Cat/branches/main", { commit: { sha: "h1" } });
const runsPath = `/repos/${WORKER_REPO}/actions/workflows/review.yml/runs`;
const noRuns: Handler = (url) => (url.pathname === runsPath ? ok({ total_count: 3, workflow_runs: [] }) : undefined);
const dispatched = at(`/repos/${WORKER_REPO}/actions/workflows/review.yml/dispatches`, () => new Response(null, { status: 204 }), "POST");
const statusFile = (v: unknown): Handler => at(`/repos/${WORKER_REPO}/contents/reviews/Octo__Cat/status.json`, v);

function deps(gh: Deps["gh"], frozen = false): Deps {
  return { gh, frozen: async () => frozen, newJob: () => "job-123456", now: () => new Date("2026-10-13T12:00:00Z") };
}

describe("run titles", () => {
  test("round-trip repo and job", () => {
    const t = runTitle("Octo/Cat", "job-123456");
    expect(t).toBe("review Octo/Cat [job-123456]");
    expect(jobOf(t)).toBe("job-123456");
    expect(repoOf(t)).toBe("Octo/Cat");
    expect(jobOf("review a/b")).toBeNull();
    expect(slugOf("Octo/Cat")).toBe("Octo__Cat");
  });
  test("stages", () => {
    expect([stageOf(null), stageOf("Install Roster"), stageOf("Review"), stageOf("Publish")]).toEqual(["starting", "starting", "reviewing", "publishing"]);
  });
});

describe("requestReview", () => {
  test("a frozen review is served without calling GitHub", async () => {
    const f = fakeGitHub();
    expect(await requestReview(deps(f.gh, true), "rajkaria", "roster")).toEqual({ status: 200, body: { cached: true, href: "/r/rajkaria/roster" } });
    expect(f.calls).toEqual([]);
  });

  test("missing or private repos are not found", async () => {
    expect((await requestReview(deps(fakeGitHub().gh), "octo", "cat")).body.error).toBe("not_found");
    const priv = fakeGitHub(at("/repos/octo/cat", { ...REPO, private: true }));
    expect((await requestReview(deps(priv.gh), "octo", "cat")).status).toBe(404);
  });

  test("a bad or rate-limited token is an error, never a not-found repo", async () => {
    for (const status of [401, 403]) {
      const f = fakeGitHub(at("/repos/octo/cat", () => new Response("{}", { status })));
      await expect(requestReview(deps(f.gh), "octo", "cat")).rejects.toThrow(/GitHub refused/);
    }
  });

  test("a repo over the size cap is refused", async () => {
    const f = fakeGitHub(at("/repos/octo/cat", { ...REPO, size: SIZE_CAP_KB + 1 }));
    expect(await requestReview(deps(f.gh), "octo", "cat")).toMatchObject({ status: 413, body: { error: "too_large" } });
  });

  test("no checkpoint branch and no checkpoint refs is no_entire_data, with the canonical name", async () => {
    const f = fakeGitHub(repoInfo, at("/repos/Octo/Cat/git/matching-refs/entire/checkpoints/", []));
    expect(await requestReview(deps(f.gh), "octo", "cat")).toMatchObject({ status: 422, body: { error: "no_entire_data", repo: "Octo/Cat" } });
  });

  test("checkpoint refs (no branch) count as Entire data", async () => {
    const f = fakeGitHub(repoInfo, at("/repos/Octo/Cat/git/matching-refs/entire/checkpoints/", [{ ref: "refs/entire/checkpoints/v1" }]), mainHead, noRuns, dispatched);
    expect((await requestReview(deps(f.gh), "octo", "cat")).status).toBe(202);
  });

  test("a live review of the same heads is served from cache", async () => {
    const f = fakeGitHub(repoInfo, cpBranch, mainHead, statusFile({ repo: "Octo/Cat", outcome: "ok", target_head: "h1", checkpoint_head: "cp1" }));
    expect(await requestReview(deps(f.gh), "octo", "cat")).toEqual({ status: 200, body: { cached: true, live: true, href: "/r/Octo/Cat" } });
  });

  test("new commits or new checkpoints mean a fresh run", async () => {
    for (const stale of [{ target_head: "old", checkpoint_head: "cp1" }, { target_head: "h1", checkpoint_head: "old" }]) {
      const f = fakeGitHub(repoInfo, cpBranch, mainHead, statusFile({ repo: "Octo/Cat", outcome: "ok", ...stale }), noRuns, dispatched);
      expect(await requestReview(deps(f.gh), "octo", "cat")).toEqual({ status: 202, body: { job: "job-123456", repo: "Octo/Cat" } });
    }
  });

  test("a failed earlier run is not a cache hit", async () => {
    const f = fakeGitHub(repoInfo, cpBranch, mainHead, statusFile({ repo: "Octo/Cat", outcome: "failed", target_head: "h1", checkpoint_head: "cp1" }), noRuns, dispatched);
    expect((await requestReview(deps(f.gh), "octo", "cat")).body.job).toBe("job-123456");
  });

  test("a run already going for the repo is joined, not duplicated", async () => {
    const running: Handler = (url) =>
      url.pathname === runsPath && !url.search.includes("created")
        ? ok({ workflow_runs: [{ id: 9, display_title: "review octo/cat [other-job-1]", status: "in_progress", conclusion: null, html_url: "u", created_at: "" }] })
        : undefined;
    const f = fakeGitHub(repoInfo, cpBranch, mainHead, running, dispatched);
    expect(await requestReview(deps(f.gh), "octo", "cat")).toEqual({ status: 202, body: { job: "other-job-1", repo: "Octo/Cat" } });
    expect(f.calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("dispatch sends the canonical repo and the new job id on main", async () => {
    const f = fakeGitHub(repoInfo, cpBranch, mainHead, noRuns, dispatched);
    await requestReview(deps(f.gh), "octo", "cat");
    expect(f.calls.find((c) => c.method === "POST")?.body).toEqual({ ref: "main", inputs: { repo: "Octo/Cat", job: "job-123456" } });
    const cap = f.calls.find((c) => c.path.includes("created="));
    expect(decodeURIComponent(cap!.path)).toContain("created=>=2026-10-12T12:00:00.000Z");
  });

  test("the daily cap, or a GitHub that will not say how many runs there were, refuses", async () => {
    const full: Handler = (url) => (url.pathname === runsPath ? ok({ total_count: DAILY_CAP, workflow_runs: [] }) : undefined);
    const f = fakeGitHub(repoInfo, cpBranch, mainHead, full, dispatched);
    expect(await requestReview(deps(f.gh), "octo", "cat")).toMatchObject({ status: 503, body: { error: "busy" } });
    const broken: Handler = (url) => (url.pathname === runsPath && url.search.includes("created") ? new Response("", { status: 500 }) : undefined);
    const g = fakeGitHub(repoInfo, cpBranch, mainHead, broken, noRuns, dispatched);
    expect((await requestReview(deps(g.gh), "octo", "cat")).status).toBe(503);
  });

  test("a refused dispatch says nothing was run", async () => {
    const f = fakeGitHub(repoInfo, cpBranch, mainHead, noRuns);
    expect(await requestReview(deps(f.gh), "octo", "cat")).toMatchObject({ status: 502, body: { error: "dispatch_failed" } });
  });
});

describe("jobStatus", () => {
  const run = (over: object) => (url: URL) =>
    url.pathname === runsPath
      ? ok({ workflow_runs: [{ id: 7, display_title: "review Octo/Cat [job-123456]", status: "completed", conclusion: "success", html_url: "https://run", created_at: "", ...over }] })
      : undefined;

  test("a run GitHub does not list yet is queued", async () => {
    expect((await jobStatus({ gh: fakeGitHub(noRuns).gh }, "job-123456", "Octo/Cat")).body).toEqual({ state: "queued" });
  });

  test("an in-progress run reports its stage", async () => {
    const jobs = at(`/repos/${WORKER_REPO}/actions/runs/7/jobs`, { jobs: [{ steps: [{ name: "Install Roster", status: "completed" }, { name: "Review", status: "in_progress" }] }] });
    const f = fakeGitHub(run({ status: "in_progress", conclusion: null }), jobs);
    expect((await jobStatus(f, "job-123456", "Octo/Cat")).body).toEqual({ state: "running", stage: "reviewing", run_url: "https://run" });
  });

  test("a successful run with an ok status links to the review", async () => {
    const f = fakeGitHub(run({}), statusFile({ job: "job-123456", repo: "Octo/Cat", outcome: "ok" }));
    expect((await jobStatus(f, "job-123456", "octo/cat")).body).toEqual({ state: "done", href: "/r/Octo/Cat", run_url: "https://run" });
  });

  test("no Entire data and failures carry the worker's message and the run log", async () => {
    const none = fakeGitHub(run({}), statusFile({ job: "job-123456", repo: "Octo/Cat", outcome: "no_entire_data", error: "This repo has no Entire checkpoints." }));
    expect((await jobStatus(none, "job-123456", "Octo/Cat")).body).toMatchObject({ state: "failed", error: "no_entire_data", run_url: "https://run" });
    const failed = fakeGitHub(run({ conclusion: "failure" }));
    expect((await jobStatus(failed, "job-123456", "Octo/Cat")).body).toMatchObject({ state: "failed", error: "failed", message: "The review run failed." });
  });
});
