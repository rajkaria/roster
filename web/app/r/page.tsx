import Link from "next/link";
import type { Metadata } from "next";
import { listReviews } from "@/lib/reviews";
import type { ReviewLabel } from "@/lib/types";

export const metadata: Metadata = {
  title: "Reviews · Roster",
  description: "Every public repo Roster has reviewed, most sessions first.",
};

const LABEL_TEXT: Record<ReviewLabel, string> = {
  suspect: "suspect",
  no_suspect: "no suspect",
  insufficient_data: "insufficient data",
};

export default function ReviewsIndex() {
  const rows = listReviews();
  return (
    <>
      <h1>Reviews</h1>
      <p className="lede">Each review compares the agent setups that worked on one public repo.</p>
      <p className="meta">Evidence: level A: observational. A setup is never called worse on level A alone.</p>
      {rows.length === 0 ? (
        <div className="empty">No reviews have been published yet.</div>
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
                <th>Generated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.href}>
                  <td>
                    <Link href={r.href}>{r.owner}/{r.repo}</Link>
                  </td>
                  <td className="num">{r.sessions}</td>
                  <td className="num">{r.mature_sessions}</td>
                  <td className="num">{r.setups}</td>
                  <td>{LABEL_TEXT[r.label] ?? r.label}</td>
                  <td className="num">{r.generated_at.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
