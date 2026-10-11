"use client";
// The /try form: posts the pasted repo to /api/review and says plainly what came back.
import { useState } from "react";

import { mapResponse, type TryState } from "./tryState";

const CONTROL = {
  padding: "10px 12px",
  font: "inherit",
  color: "inherit",
  background: "transparent",
  border: "1px solid var(--line)",
  borderRadius: 6,
} as const;

export function TryForm() {
  const [value, setValue] = useState("");
  const [state, setState] = useState<TryState>({ kind: "idle" });

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
      setState(mapResponse(res.status, body, value));
    } catch {
      setState({ kind: "error", message: "Could not reach the server. Nothing was reviewed." });
    }
  }

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
        <button type="submit" disabled={state.kind === "loading"} style={{ ...CONTROL, cursor: "pointer" }}>
          {state.kind === "loading" ? "Checking…" : "Review"}
        </button>
      </form>
      <div role="status" aria-live="polite">
        <Result state={state} />
      </div>
    </>
  );
}

function Result({ state }: { state: TryState }) {
  switch (state.kind) {
    case "invalid":
    case "error":
    case "rate_limited":
      return <p className="meta">{state.message}</p>;
    case "cached":
      return (
        <p>
          This repo already has a review: <a href={state.href}>{state.label}</a>
        </p>
      );
    case "queued":
      return (
        <div className="empty" style={{ textAlign: "left" }}>
          <p style={{ marginTop: 0 }}>Not reviewed yet. Run it yourself:</p>
          <pre style={{ overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            <code>{state.command}</code>
          </pre>
          <p style={{ marginBottom: 0 }}>
            Hosted runs on isolated sandboxes are coming. No review has been started for you.
          </p>
        </div>
      );
    default:
      return null;
  }
}
