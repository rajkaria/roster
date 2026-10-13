// Pure state mapping for the /try form. Kept apart from TryForm.tsx so tests can import it without JSX.
// Post-deadline (13 Oct): a 202 with a job id means a live review is running; the page polls
// GET /api/review?job=&repo= and maps each answer with mapPoll.

export type Stage = "queued" | "starting" | "reviewing" | "publishing";

export type TryState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "invalid"; message: string }
  | { kind: "rate_limited"; message: string }
  | { kind: "cached"; href: string; label: string; live?: boolean }
  | { kind: "queued"; command: string }
  | { kind: "running"; job: string; repo: string; stage: Stage; runUrl: string | null; startedAt: number }
  | { kind: "done"; href: string; label: string; runUrl: string | null }
  | { kind: "no_entire_data"; repo: string }
  | { kind: "refused"; message: string }
  | { kind: "failed"; message: string; runUrl: string | null }
  | { kind: "error"; message: string };

/** How long the page waits for a live review before it stops polling and points at the run log. */
export const GIVE_UP_MS = 25 * 60_000;
export const POLL_MS = 3_000;

/** `owner/repo` from a pasted reference, using the same shapes the API accepts. Null when it is not one. */
export function repoFromInput(input: string): { owner: string; repo: string } | null {
  const raw = input.trim().replace(/\/+$/, "");
  const m = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(raw);
  return m?.[1] && m[2] ? { owner: m[1], repo: m[2] } : null;
}

type Body = Record<string, unknown> | null;
const field = (body: Body, key: string): string | null => {
  const v = body?.[key];
  return typeof v === "string" ? v : null;
};

/** Maps the POST's status and body to what the page shows. `now` is the time the answer came back. */
export function mapResponse(status: number, body: unknown, input: string, now: number = Date.now()): TryState {
  const b = (typeof body === "object" && body !== null ? body : null) as Body;
  const err = field(b, "error") ?? "";
  const ref = repoFromInput(input);
  const label = ref ? `${ref.owner}/${ref.repo}` : "";
  if (status === 400) return { kind: "invalid", message: err || "That is not a GitHub repository URL." };
  if (status === 429) return { kind: "rate_limited", message: "Try again in a minute" };
  if (status === 200 && b?.cached === true && ref) {
    const href = field(b, "href") ?? `/r/${ref.owner}/${ref.repo}`;
    return { kind: "cached", href, label: href.replace(/^\/r\//, ""), ...(b.live === true ? { live: true } : {}) };
  }
  if (status === 202 && ref) {
    const job = field(b, "job");
    if (job) return { kind: "running", job, repo: field(b, "repo") ?? label, stage: "queued", runUrl: null, startedAt: now };
    return { kind: "queued", command: `bun src/cli.ts review https://github.com/${ref.owner}/${ref.repo} --observational` };
  }
  if (status === 422 && err === "no_entire_data") return { kind: "no_entire_data", repo: field(b, "repo") ?? label };
  const message = field(b, "message");
  if ([404, 413, 502, 503].includes(status) && message) return { kind: "refused", message };
  return { kind: "error", message: "Something went wrong. Nothing was reviewed." };
}

const STAGES: readonly Stage[] = ["queued", "starting", "reviewing", "publishing"];

/** The next state while polling a running review. A failed poll is ignored, so one bad answer never ends the run. */
export function mapPoll(prev: Extract<TryState, { kind: "running" }>, status: number, body: unknown, now: number = Date.now()): TryState {
  if (now - prev.startedAt > GIVE_UP_MS) {
    return { kind: "failed", message: "The review is taking longer than expected. The run log has the details.", runUrl: prev.runUrl };
  }
  const b = (typeof body === "object" && body !== null ? body : null) as Body;
  if (status !== 200 || !b) return prev;
  const runUrl = field(b, "run_url") ?? prev.runUrl;
  switch (field(b, "state")) {
    case "queued":
      return { ...prev, runUrl };
    case "running": {
      const stage = field(b, "stage") as Stage | null;
      // Stages only move forward, so a late answer never shows the run going backwards.
      const next = stage && STAGES.indexOf(stage) > STAGES.indexOf(prev.stage) ? stage : prev.stage;
      return { ...prev, stage: next === "queued" ? "starting" : next, runUrl };
    }
    case "done": {
      const href = field(b, "href") ?? `/r/${prev.repo}`;
      return { kind: "done", href, label: href.replace(/^\/r\//, ""), runUrl };
    }
    case "failed":
      if (field(b, "error") === "no_entire_data") return { kind: "no_entire_data", repo: prev.repo };
      return { kind: "failed", message: field(b, "message") ?? "The review run failed.", runUrl };
    default:
      return prev;
  }
}

/** "1:05" for 65 seconds. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
