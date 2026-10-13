// Live reviews (post-deadline, 13 Oct): /try dispatches a GitHub Actions run in rajkaria/roster-reviews, which runs
// `roster review --observational` on a public repo and commits the result to reviews/<owner>__<name>/.
// Everything here talks to GitHub through an injected `fetch`, so tests run offline. No Next.js imports.

export const WORKER_REPO = "rajkaria/roster-reviews";
export const WORKFLOW = "review.yml";
/** Repos bigger than this (GitHub's `size`, in KB) are refused: the worker makes a full clone. */
export const SIZE_CAP_KB = 300 * 1024;
/** Most dispatches in any 24 hours, across all callers. */
export const DAILY_CAP = 150;
const API = "https://api.github.com";
const RAW = `https://raw.githubusercontent.com/${WORKER_REPO}/main`;

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** What the worker writes next to each result. */
export interface LiveStatus {
  job: string;
  repo: string;
  outcome: "ok" | "no_entire_data" | "failed";
  error: string | null;
  run_id: number;
  run_url: string;
  roster_sha: string;
  target_head: string;
  checkpoint_head: string | null;
  started_at: string;
  finished_at: string;
}

export interface WorkflowRun {
  id: number;
  display_title: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
}

/** `owner__name`, the directory a repo's review lives in. */
export const slugOf = (fullName: string): string => fullName.replace("/", "__");
export const runTitle = (repo: string, job: string): string => `review ${repo} [${job}]`;
export const JOB_RE = /^[A-Za-z0-9-]{6,64}$/;

/** The job id at the end of a run's title, or null. */
export function jobOf(title: string): string | null {
  const m = /\[([A-Za-z0-9-]{6,64})\]$/.exec(title);
  return m ? m[1]! : null;
}

/** The repo in a run's title (`review owner/name [job]`), or null. */
export function repoOf(title: string): string | null {
  const m = /^review (\S+\/\S+) \[[A-Za-z0-9-]{6,64}\]$/.exec(title);
  return m ? m[1]! : null;
}

/** GitHub REST calls with the dispatch token. */
export function github(token: string, fetchImpl: Fetch = fetch) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "tryroster.dev",
  };
  return (path: string, init: RequestInit = {}) =>
    fetchImpl(`${API}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) }, signal: AbortSignal.timeout(10_000) });
}
export type Gh = ReturnType<typeof github>;

/** 401 (bad token) and 403 (rate limit, or a token without the permission) say nothing about the repo asked about. */
async function json<T>(res: Response): Promise<T | null> {
  if (res.status === 401 || res.status === 403) throw new Error(`GitHub refused the request (${res.status})`);
  if (!res.ok) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

const enc = (fullName: string) => fullName.split("/").map(encodeURIComponent).join("/");

export type RepoInfo =
  | { kind: "ok"; fullName: string; sizeKb: number; defaultBranch: string }
  | { kind: "not_found" }
  | { kind: "private" };

/** The repo as GitHub names it. A token that cannot see a private repo gets a 404, so both read as not found. */
export async function lookupRepo(gh: Gh, owner: string, repo: string): Promise<RepoInfo> {
  const r = await json<{ full_name: string; private: boolean; size: number; default_branch: string }>(
    await gh(`/repos/${enc(`${owner}/${repo}`)}`),
  );
  if (!r) return { kind: "not_found" };
  if (r.private) return { kind: "private" };
  return { kind: "ok", fullName: r.full_name, sizeKb: r.size, defaultBranch: r.default_branch };
}

/** Head of a branch, or null when it does not exist. */
export async function branchHead(gh: Gh, fullName: string, branch: string): Promise<string | null> {
  const r = await json<{ commit?: { sha?: string } }>(await gh(`/repos/${enc(fullName)}/branches/${encodeURIComponent(branch)}`));
  return r?.commit?.sha ?? null;
}

export const CHECKPOINT_BRANCH = "entire/checkpoints/v1";

/** Where the repo keeps Entire checkpoints, as Roster's fetch looks for them: the branch, else refs/entire/checkpoints/*. */
export async function checkpoints(gh: Gh, fullName: string): Promise<{ backend: "branch" | "refs" | "none"; head: string | null }> {
  const head = await branchHead(gh, fullName, CHECKPOINT_BRANCH);
  if (head) return { backend: "branch", head };
  const refs = await json<unknown[]>(await gh(`/repos/${enc(fullName)}/git/matching-refs/entire/checkpoints/`));
  return Array.isArray(refs) && refs.length > 0 ? { backend: "refs", head: null } : { backend: "none", head: null };
}

/** A file in the worker repo, fresh (contents API) when there is a token, else from the raw CDN. Null when absent. */
export async function workerFile(path: string, opts: { gh?: Gh; fetchImpl?: Fetch; init?: RequestInit } = {}): Promise<string | null> {
  const res = opts.gh
    ? await opts.gh(`/repos/${WORKER_REPO}/contents/${path}`, { ...opts.init, headers: { accept: "application/vnd.github.raw" } })
    : await (opts.fetchImpl ?? fetch)(`${RAW}/${path}`, opts.init);
  return res.ok ? res.text() : null;
}

export async function liveStatus(slug: string, opts: { gh?: Gh; fetchImpl?: Fetch; init?: RequestInit }): Promise<LiveStatus | null> {
  const text = await workerFile(`reviews/${slug}/status.json`, opts);
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as LiveStatus;
    return typeof v?.repo === "string" && typeof v?.outcome === "string" ? v : null;
  } catch {
    return null;
  }
}

/** The worker's most recent runs, newest first. */
export async function recentRuns(gh: Gh, perPage = 50): Promise<WorkflowRun[]> {
  const r = await json<{ workflow_runs: WorkflowRun[] }>(
    await gh(`/repos/${WORKER_REPO}/actions/workflows/${WORKFLOW}/runs?per_page=${perPage}`),
  );
  return r?.workflow_runs ?? [];
}

/** Runs created since `since`, for the daily cap. Null when GitHub did not answer (the caller then refuses). */
export async function runsSince(gh: Gh, since: Date): Promise<number | null> {
  const r = await json<{ total_count: number }>(
    await gh(`/repos/${WORKER_REPO}/actions/workflows/${WORKFLOW}/runs?per_page=1&created=${encodeURIComponent(`>=${since.toISOString()}`)}`),
  );
  return typeof r?.total_count === "number" ? r.total_count : null;
}

export async function dispatch(gh: Gh, repo: string, job: string): Promise<boolean> {
  const res = await gh(`/repos/${WORKER_REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { repo, job } }),
  });
  return res.status === 204 || res.ok;
}

/** The name of the step a run is on, or null. */
export async function currentStep(gh: Gh, runId: number): Promise<string | null> {
  const r = await json<{ jobs: { steps?: { name: string; status: string }[] }[] }>(
    await gh(`/repos/${WORKER_REPO}/actions/runs/${runId}/jobs`),
  );
  const steps = r?.jobs?.[0]?.steps ?? [];
  return steps.find((s) => s.status === "in_progress")?.name ?? null;
}

/** What the /try page says while a run is on a given workflow step. */
export function stageOf(step: string | null): "starting" | "reviewing" | "publishing" {
  if (step === "Publish") return "publishing";
  if (step === "Review" || step === "Read the repo's heads") return "reviewing";
  return "starting";
}

// ---------- POST /api/review and GET /api/review?job= ----------

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

export interface Deps {
  gh: Gh;
  /** True when a frozen (hackathon-time) review is published for the repo. */
  frozen: (owner: string, repo: string) => Promise<boolean>;
  newJob: () => string;
  now: () => Date;
}

const href = (fullName: string) => `/r/${fullName}`;

/**
 * Decides what a paste on /try does, in order: a frozen review; the repo must exist, be public, fit the size cap
 * and have Entire checkpoints; a live review of the same heads; a run already going for it; the daily cap;
 * then a dispatch.
 */
export async function requestReview(d: Deps, owner: string, repo: string): Promise<Reply> {
  if (await d.frozen(owner, repo)) return { status: 200, body: { cached: true, href: href(`${owner}/${repo}`) } };

  const info = await lookupRepo(d.gh, owner, repo);
  if (info.kind !== "ok") {
    return { status: 404, body: { error: "not_found", message: "No public GitHub repo by that name. Private repos can't be reviewed live." } };
  }
  const { fullName } = info;
  if (info.sizeKb > SIZE_CAP_KB) {
    return { status: 413, body: { error: "too_large", message: `This repo is over ${SIZE_CAP_KB / 1024} MB, too big for a live review. Run Roster locally instead.` } };
  }
  const cp = await checkpoints(d.gh, fullName);
  if (cp.backend === "none") {
    return { status: 422, body: { error: "no_entire_data", repo: fullName, message: "This repo has no Entire checkpoints, so there are no recorded sessions to review." } };
  }

  const [head, status] = await Promise.all([branchHead(d.gh, fullName, info.defaultBranch), liveStatus(slugOf(fullName), { gh: d.gh })]);
  if (status?.outcome === "ok" && head !== null && status.target_head === head && (cp.head === null || status.checkpoint_head === cp.head)) {
    return { status: 200, body: { cached: true, live: true, href: href(fullName) } };
  }

  const running = (await recentRuns(d.gh)).find(
    (r) => r.status !== "completed" && repoOf(r.display_title)?.toLowerCase() === fullName.toLowerCase(),
  );
  const job = running ? jobOf(running.display_title) : null;
  if (job) return { status: 202, body: { job, repo: fullName } };

  const today = await runsSince(d.gh, new Date(d.now().getTime() - 24 * 3600_000));
  if (today === null || today >= DAILY_CAP) {
    return { status: 503, body: { error: "busy", message: "Live reviews are at today's limit. Try again tomorrow, or run Roster locally." } };
  }

  const fresh = d.newJob();
  if (!(await dispatch(d.gh, fullName, fresh))) {
    return { status: 502, body: { error: "dispatch_failed", message: "Could not start the review. Nothing was run." } };
  }
  return { status: 202, body: { job: fresh, repo: fullName } };
}

/** Where a dispatched job is. `queued` covers the few seconds before GitHub lists a new run. */
export async function jobStatus(d: Pick<Deps, "gh">, job: string, repo: string): Promise<Reply> {
  const run = (await recentRuns(d.gh)).find((r) => jobOf(r.display_title) === job);
  if (!run) return { status: 200, body: { state: "queued" } };
  if (run.status !== "completed") {
    if (run.status !== "in_progress") return { status: 200, body: { state: "queued", run_url: run.html_url } };
    return { status: 200, body: { state: "running", stage: stageOf(await currentStep(d.gh, run.id)), run_url: run.html_url } };
  }
  const status = await liveStatus(slugOf(repoOf(run.display_title) ?? repo), { gh: d.gh });
  if (run.conclusion === "success" && status?.outcome === "ok") {
    return { status: 200, body: { state: "done", href: href(status.repo), run_url: run.html_url } };
  }
  if (status?.job === job && status.outcome === "no_entire_data") {
    return { status: 200, body: { state: "failed", error: "no_entire_data", message: status.error, run_url: run.html_url } };
  }
  return {
    status: 200,
    body: {
      state: "failed",
      error: "failed",
      message: status?.job === job && status.error ? status.error : "The review run failed.",
      run_url: run.html_url,
    },
  };
}
