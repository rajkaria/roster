import type { Review } from "@/lib/types";
import { GITHUB, SELF_OWNER, SELF_REPO, landingRows, landingTotals } from "./LandingData";

export function Hero() {
  return (
    <section className="hero">
      <h1>Roster runs performance reviews for your AI coding agents.</h1>
      <p className="lede">
        It finds the setup that&apos;s quietly making your codebase worse, tests a better one on your own past tasks,
        and ships it only if nothing regresses.
      </p>
    </section>
  );
}

const H2 = ({ children }: { children: React.ReactNode }) => <h2 className="land-h2">{children}</h2>;

export function OwnReview({ review }: { review: Review | null }) {
  const href = `/r/${SELF_OWNER}/${SELF_REPO}`;
  if (!review) {
    return (
      <section className="land">
        <H2>Our own AI team&apos;s review</H2>
        <div className="empty">This repo&apos;s review has not been published yet.</div>
      </section>
    );
  }
  const rows = landingRows(review);
  const total = landingTotals(review);
  return (
    <section className="land">
      <H2>
        Our own AI team&apos;s review{" "}
        <span className="badge" title="Evidence level">level {review.evidence_level}</span>
      </H2>
      <p className="meta">
        The coding agents building Roster, reviewed by Roster. {review.repo}, generated {review.generated_at}.
      </p>
      <div className="scroll">
        <table className="compact">
          <thead>
            <tr><th>Setup</th><th>Sessions</th><th>Spend</th><th>Unattended</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.setup_id}>
                <td>{r.label}<span className="sub">{r.setup_id}</span></td>
                <td className="num">{r.sessions}</td>
                <td className="num">{r.spend}</td>
                <td className="num">{r.unattended}</td>
              </tr>
            ))}
            <tr className="total">
              <td>All setups</td>
              <td className="num">{total.sessions}</td>
              <td className="num">{total.spend}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        <a href={href}>Read the full review →</a>
      </p>
    </section>
  );
}

const LEVELS = [
  {
    level: "A",
    name: "Observational",
    text: "Roster reads every recorded agent session and scores what happened to its change: kept, reverted, or reworked by a person. This points at a suspect setup but proves nothing on its own.",
  },
  {
    level: "B",
    name: "Controlled replay",
    text: "Roster reruns the suspect's real past tasks at their parent commit, under the current setup and under candidates, and grades every attempt with hidden tests. A candidate is promoted only if nothing regresses.",
  },
  {
    level: "C",
    name: "Pre-registered forward test",
    text: "New tasks, written down before the decision, run through the old and the new setup side by side. This checks that the decision holds on work that did not exist yet.",
  },
];

export function HowItWorks() {
  return (
    <section className="land">
      <H2>How it works</H2>
      <p className="meta">Every claim on a Roster page carries the evidence level behind it. A setup is never called worse on level A alone.</p>
      <div className="cards">
        {LEVELS.map((l) => (
          <div className="card" key={l.level}>
            <div><span className="badge">level {l.level}</span> <strong>{l.name}</strong></div>
            <p>{l.text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Experiment({ started }: { started: boolean }) {
  const blob = `${GITHUB}/blob/main/experiments`;
  return (
    <section className="land">
      <H2>The experiment</H2>
      <p>
        Roster is building itself with several agent setups, and its first review of this repo picks which setup to
        promote. Before that review ran, we froze a backlog of new tasks and their acceptance tests and published
        their hashes in <a href={`${blob}/FREEZE.txt`} rel="noopener noreferrer">FREEZE.txt</a>. The hypotheses, tests
        and stop rules are fixed in <a href={`${blob}/PREREGISTRATION.md`} rel="noopener noreferrer">PREREGISTRATION.md</a>.
        Results get published whatever they show.
      </p>
      <p className="banner">
        Status: {started ? (
          <>forward run started. <a href={`/r/${SELF_OWNER}/${SELF_REPO}`}>See the results so far →</a></>
        ) : (
          "forward run not started."
        )}
      </p>
    </section>
  );
}

const TOOLS = [
  { name: "Entire", href: "https://entire.io", text: "records every coding agent session with its prompts, tokens and commit, and Roster reads those records as its input." },
  { name: "neatlogs", href: "https://neatlogs.com", text: "traces every Roster run, from ingest to each replay attempt and gate decision, so each result links to how it was produced." },
  { name: "cfo.ai", href: "https://cfo.ai", text: "is where Roster books the AI team's spend per setup as a department in the company plan." },
];

export function BuiltWith() {
  return (
    <section className="land">
      <H2>Built with Entire, neatlogs and cfo.ai</H2>
      <ul className="tools">
        {TOOLS.map((t) => (
          <li key={t.name}>
            <a href={t.href} rel="noopener noreferrer">{t.name}</a> {t.text}
          </li>
        ))}
      </ul>
    </section>
  );
}
