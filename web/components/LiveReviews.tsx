"use client";
// The live-reviews table on /r (post-deadline): reviews Roster ran from /try, read from /api/live in the browser.
import { useEffect, useState } from "react";

interface Row {
  repo: string;
  href: string;
  sessions: number;
  mature_sessions: number;
  setups: unknown[];
  label: string | null;
  generated_at: string | null;
}

const LABEL_TEXT: Record<string, string> = {
  suspect: "suspect",
  no_suspect: "no suspect",
  insufficient_data: "insufficient data",
};

export function LiveReviews() {
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    fetch("/api/live")
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { reviews?: Row[] } | null) => setRows(Array.isArray(b?.reviews) ? b.reviews : []))
      .catch(() => setRows([]));
  }, []);

  return (
    <section style={{ marginTop: 40 }}>
      <h2 style={{ fontSize: "1.15rem", margin: "0 0 8px" }}>Live reviews</h2>
      <p className="meta">
        Run from <a href="/try">/try</a> after the neatHack deadline, one GitHub Actions run each, committed to{" "}
        <a href="https://github.com/rajkaria/roster-reviews">rajkaria/roster-reviews</a>. Level A, observational.
      </p>
      {rows === null ? (
        <div className="empty">Loading live reviews…</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          No live reviews yet. <a href="/try">Review a repo</a>.
        </div>
      ) : (
        <div className="scroll">
          <table className="compact">
            <thead>
              <tr>
                <th>Repo</th>
                <th>Sessions</th>
                <th>Mature sessions</th>
                <th>Setups</th>
                <th>Suspect label</th>
                <th>Reviewed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.href}>
                  <td>
                    <a href={r.href}>{r.repo}</a>
                  </td>
                  <td className="num">{r.sessions}</td>
                  <td className="num">{r.mature_sessions}</td>
                  <td className="num">{r.setups.length}</td>
                  <td>{r.label ? LABEL_TEXT[r.label] ?? r.label : "n/a"}</td>
                  <td className="num">{r.generated_at?.slice(0, 10) ?? "n/a"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
