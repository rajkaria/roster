import { join } from "node:path";
import type { Metadata } from "next";
import { bookContext, loadBookFromData } from "@/lib/book";

const TITLE = "Book: the AI workforce Roster runs on cfo.ai";
const DESCRIPTION =
  "The AI workforce department Roster books into cfo.ai, with what each setup costs a month and what the promoted setup costs next to a hire.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website" },
};

export default function BookPage() {
  const book = loadBookFromData(join(process.cwd(), "public", "data"));
  const assumed = bookContext(join(process.cwd(), "public", "data"));

  return (
    <>
      <h1>Book</h1>
      <p className="lede">
        Roster books the AI workforce it measured into cfo.ai: each setup&apos;s monthly spend, what a surviving
        change costs it, and how much of its work ran unattended. It then prices the promoted setup against a
        hire.
      </p>

      <section className="land">
        <h2 className="land-h2">AI workforce department</h2>
        {assumed.periodDays !== null && (
          <p className="meta">
            Monthly figures scale {assumed.periodDays} days of this repo&apos;s sessions to a month. Per surviving
            change here is monthly spend over monthly surviving changes, all sessions; the review&apos;s own figure counts
            mature sessions only.
          </p>
        )}
        {!book.rows.length ? (
          <div className="empty">No book has been published yet.</div>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Setup</th>
                  <th>Monthly spend</th>
                  <th>Per surviving change</th>
                  <th>Unattended</th>
                </tr>
              </thead>
              <tbody>
                {book.rows.map((row, i) => (
                  <tr key={`${row.setup}-${i}`}>
                    <td>
                      {row.label}
                      <span className="sub">{row.setup}</span>
                    </td>
                    <td>{row.monthly}</td>
                    <td>{row.perChange}</td>
                    <td>{row.unattended}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="land">
        <h2 className="land-h2">Hire an engineer, or scale the promoted setup</h2>
        {book.scenario === null ? (
          <div className="empty">No hire-versus-scale scenario has been published yet.</div>
        ) : (
          <div className="cards">
            <div className="card">
              <strong>Hire an engineer</strong>
              <p>{book.scenario.hire} a month, loaded (an assumption).</p>
            </div>
            <div className="card">
              <strong>Scale the promoted setup</strong>
              <p>{book.scenario.scale} a month at the promoted setup&apos;s own rate{assumed.sessionsPerWeek !== null && `, at an assumed ${assumed.sessionsPerWeek} sessions a week`}.</p>
            </div>
          </div>
        )}
      </section>

      {book.shareUrl && (
        <p>
          <a href={book.shareUrl} rel="noopener noreferrer" target="_blank">
            View in cfo.ai
          </a>
        </p>
      )}
    </>
  );
}
