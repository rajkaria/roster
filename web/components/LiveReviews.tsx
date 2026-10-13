"use client";
// The live-reviews table on /r (post-deadline): reviews Roster ran from /try, read from /api/live in the browser.
import { useEffect, useState } from "react";

import { byModel, type SetupSummary } from "@/lib/live-aggregate";

interface Row {
  repo: string;
  href: string;
  sessions: number;
  mature_sessions: number;
  setups: SetupSummary[];
  label: string | null;
  generated_at: string | null;
}

const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(0)}%`);
const usd = (v: number | null) => (v === null ? "n/a" : `$${v.toFixed(2)}`);

function ByModel({ rows }: { rows: Row[] }) {
  const models = byModel(rows).slice(0, 12);
  return (
    <>
      <h3 style={{ fontSize: "1rem", margin: "20px 0 6px" }}>By model, across {rows.length} live-reviewed repos</h3>
      <p className="meta">
        Descriptive only: level A, observational, and each repo&apos;s agents had different work. Survival is weighted by
        mature sessions. Spend counts fully priced setups only, at API list prices.
      </p>
      <div className="scroll">
        <table className="compact">
          <thead>
            <tr>
              <th>Model</th>
              <th>Repos</th>
              <th>Sessions</th>
              <th>Mature</th>
              <th>Survival</th>
              <th>Priced spend</th>
              <th>$/surviving change</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.model}>
                <td><code>{m.model}</code></td>
                <td className="num">{m.repos}</td>
                <td className="num">{m.sessions}</td>
                <td className="num">{m.mature_sessions}</td>
                <td className="num">{pct(m.survival)}</td>
                <td className="num">{usd(m.priced_spend)}</td>
                <td className="num">{usd(m.cost_per_surviving_change)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 style={{ fontSize: "1rem", margin: "20px 0 6px" }}>Repos</h3>
    </>
  );
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
        <>
        {rows.length > 1 && <ByModel rows={rows} />}
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
        </>
      )}
    </section>
  );
}
