"use client";
// The /try form: posts the pasted repo to /api/review and says plainly what came back. When a live review starts
// (post-deadline, 13 Oct), it polls the run every few seconds, shows its stage, then opens the review.
import { useEffect, useState } from "react";

import { elapsed, mapPoll, mapResponse, POLL_MS, type Stage, type TryState } from "./tryState";

const CONTROL = {
  padding: "10px 12px",
  font: "inherit",
  color: "inherit",
  background: "transparent",
  border: "1px solid var(--line)",
  borderRadius: 6,
} as const;

/** Pause on "done" before opening the review, so the finished state is seen. */
const OPEN_AFTER_MS = 1_500;

export function TryForm() {
  const [value, setValue] = useState("");
  const [state, setState] = useState<TryState>({ kind: "idle" });
  const [now, setNow] = useState(() => Date.now());

  // ?repo=owner/name prefills the box.
  useEffect(() => {
    const repo = new URLSearchParams(window.location.search).get("repo");
    if (repo) setValue(repo);
  }, []);

  const running = state.kind === "running" ? state : null;
  const job = running?.job ?? null;

  // Poll the run while it is going. Each answer goes through mapPoll, which ignores a failed poll.
  useEffect(() => {
    if (!job || !running) return;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/review?job=${encodeURIComponent(job)}&repo=${encodeURIComponent(running.repo)}`, { cache: "no-store" });
        const body: unknown = await res.json().catch(() => null);
        if (!stopped) setState((s) => (s.kind === "running" && s.job === job ? mapPoll(s, res.status, body) : s));
      } catch {
        // A dropped poll changes nothing; the next one tries again.
      }
    };
    const poll = setInterval(tick, POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    void tick();
    return () => {
      stopped = true;
      clearInterval(poll);
      clearInterval(clock);
    };
    // The run's identity is the job id; its stage changes must not restart the polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job]);

  useEffect(() => {
    if (state.kind !== "done") return;
    const t = setTimeout(() => window.location.assign(state.href), OPEN_AFTER_MS);
    return () => clearTimeout(t);
  }, [state]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState({ kind: "loading" });
    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: value }),
      });
      const body: unknown = await res.json().catch(() => null);
      setNow(Date.now());
      setState(mapResponse(res.status, body, value));
    } catch {
      setState({ kind: "error", message: "Could not reach the server. Nothing was reviewed." });
    }
  }

  const busy = state.kind === "loading" || state.kind === "running";
  return (
    <>
      <form onSubmit={submit} style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "16px 0" }}>
        <label htmlFor="repo" style={{ position: "absolute", left: -9999 }}>GitHub repository URL</label>
        <input
          id="repo"
          type="text"
          inputMode="url"
          autoComplete="off"
          placeholder="https://github.com/owner/repo"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{ ...CONTROL, flex: "1 1 240px", minWidth: 0 }}
        />
        <button type="submit" disabled={busy} style={{ ...CONTROL, cursor: busy ? "default" : "pointer" }}>
          {state.kind === "loading" ? "Checking…" : state.kind === "running" ? "Reviewing…" : "Review"}
        </button>
      </form>
      <div role="status" aria-live="polite">
        <Result state={state} now={now} />
      </div>
    </>
  );
}

const STEPS: { stage: Stage; label: string }[] = [
  { stage: "queued", label: "Queued on GitHub Actions" },
  { stage: "starting", label: "Setting up Roster" },
  { stage: "reviewing", label: "Reading Entire sessions, pricing and scoring them" },
  { stage: "publishing", label: "Publishing the review" },
];

function RunLog({ url }: { url: string | null }) {
  return url ? (
    <a href={url} target="_blank" rel="noreferrer">
      run log
    </a>
  ) : null;
}

function Progress({ state, now }: { state: Extract<TryState, { kind: "running" }>; now: number }) {
  const at = STEPS.findIndex((s) => s.stage === state.stage);
  return (
    <div className="empty" style={{ textAlign: "left" }}>
      <p style={{ marginTop: 0 }}>
        Reviewing <strong>{state.repo}</strong> · {elapsed(now - state.startedAt)}
      </p>
      <ol style={{ margin: "0 0 12px", paddingLeft: 20 }}>
        {STEPS.map((s, i) => (
          <li key={s.stage} style={{ opacity: i > at ? 0.45 : 1 }}>
            {i < at ? "✓ " : i === at ? "→ " : ""}
            {s.label}
          </li>
        ))}
      </ol>
      <p style={{ margin: 0 }}>
        Usually 1 to 3 minutes. You can leave: the review is published either way.{" "}
        {state.runUrl && (
          <>
            Watch the <RunLog url={state.runUrl} />.
          </>
        )}
      </p>
    </div>
  );
}

function Result({ state, now }: { state: TryState; now: number }) {
  switch (state.kind) {
    case "invalid":
    case "error":
    case "rate_limited":
    case "refused":
      return <p className="meta">{state.message}</p>;
    case "cached":
      return (
        <p>
          {state.live ? "Roster reviewed this repo at its current commit already: " : "This repo already has a review: "}
          <a href={state.href}>{state.label}</a>
        </p>
      );
    case "running":
      return <Progress state={state} now={now} />;
    case "done":
      return (
        <p>
          Done. Opening the review of <a href={state.href}>{state.label}</a>…
        </p>
      );
    case "no_entire_data":
      return (
        <div className="empty" style={{ textAlign: "left" }}>
          <p style={{ marginTop: 0 }}>
            <strong>{state.repo}</strong> has no Entire checkpoints, so there are no recorded agent sessions to review.
          </p>
          <p style={{ marginBottom: 0 }}>
            Roster reviews the sessions <a href="https://entire.io">Entire</a> records. Run <code>entire enable</code> in the
            repo, let your coding agents work, push the <code>entire/checkpoints/v1</code> branch, then try again.
          </p>
        </div>
      );
    case "failed":
      return (
        <p className="meta">
          {state.message} {state.runUrl && <>See the <RunLog url={state.runUrl} />.</>}
        </p>
      );
    case "queued":
      return (
        <div className="empty" style={{ textAlign: "left" }}>
          <p style={{ marginTop: 0 }}>Not reviewed yet. Run it yourself:</p>
          <pre style={{ overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            <code>{state.command}</code>
          </pre>
          <p style={{ marginBottom: 0 }}>Live reviews are switched off right now. No review has been started for you.</p>
        </div>
      );
    default:
      return null;
  }
}
