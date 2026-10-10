import { loadReview, listParams } from "@/lib/reviews";
import type { SetupRow } from "@/lib/types";
import { Section, SuspectCard, ReplaysTable, GateList, ForwardTable } from "@/components/Sections";
import { loadReplays, loadGate, loadForward, loadOutcomes } from "./sidecar";

export const dynamicParams = false;

export function generateStaticParams() {
  return listParams();
}

const pct = (v: number | null) => (v === null ? <span className="na">n/a</span> : `${(v * 100).toFixed(0)}%`);
const usd = (v: number | null) => (v === null ? <span className="na">n/a</span> : `$${v.toFixed(2)}`);

function costPerSurviving(s: SetupRow) {
  return s.spend_usd !== null && s.surviving_changes > 0 ? s.spend_usd / s.surviving_changes : null;
}

/** An unknown spend is never shown as $0: say how many sessions are priced. A lower bound reads "≥ $x". */
function spend(s: SetupRow) {
  if (s.spend_usd === null) return `unknown (${s.priced_sessions ?? 0}/${s.sessions} priced)`;
  return `${s.spend_lower_bound ? "≥ " : ""}$${s.spend_usd.toFixed(2)}`;
}

function spendPerSession(s: SetupRow) {
  if (s.spend_usd === null) return <span className="na">n/a</span>;
  return s.sessions > 0 ? `${s.spend_lower_bound ? "≥ " : ""}$${(s.spend_usd / s.sessions).toFixed(2)}` : <span className="na">n/a</span>;
}

export default async function ReviewPage({ params }: { params: Promise<{ owner: string; repo: string }> }) {
  const { owner, repo } = await params;
  const review = loadReview(owner, repo);

  if (!review) {
    return (
      <>
        <h1>{owner}/{repo}</h1>
        <div className="empty">No review has been published for this repo.</div>
      </>
    );
  }

  const terciles = new Map(loadOutcomes(owner, repo).map((o) => [o.session_id, o.tercile]));

  return (
    <>
      <h1>{review.repo}</h1>
      <p className="meta">Generated {review.generated_at}</p>
      {review.sample && (
        <div className="banner">Sample data for layout purposes. These are not real results.</div>
      )}
      <Section title="Setups" level="A">
      {!review.has_entire_data ? (
        <div className="empty">No Entire data: this repo has no recorded Entire sessions, so there is nothing to review.</div>
      ) : review.setups.length === 0 ? (
        <div className="empty">No setups found in this review yet.</div>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Setup</th>
                <th>Sessions</th>
                <th>Spend</th>
                <th>$/session</th>
                <th>Unattended</th>
                <th>Survival</th>
                <th>Revert</th>
                <th>Human rework</th>
                <th>$/surviving change</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {review.setups.map((s) => (
                <tr key={s.setup_id}>
                  <td>
                    {s.label}
                    <span className="sub">{s.harness} · {s.model}</span>
                  </td>
                  <td className="num">{s.sessions}</td>
                  <td className="num">{spend(s)}</td>
                  <td className="num">{spendPerSession(s)}</td>
                  <td className="num">{pct(s.unattended)}</td>
                  <td className="num">{pct(s.survival)}</td>
                  <td className="num">{pct(s.reverted)}</td>
                  <td className="num">{pct(s.rework_human)}</td>
                  <td className="num">{s.spend_lower_bound && costPerSurviving(s) !== null ? "≥ " : null}{usd(costPerSurviving(s))}</td>
                  <td><span className="badge" title="Evidence level">{s.evidence_level}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </Section>
      <Section title="Suspect" level="A">
        <SuspectCard review={review} />
      </Section>
      <Section title="Replays" level="B">
        <ReplaysTable replays={loadReplays(owner, repo)} terciles={terciles} setups={review.setups} />
      </Section>
      <Section title="Gate decisions" level="B">
        <GateList rows={loadGate(owner, repo)} />
      </Section>
      <Section title="Forward" level="C">
        <ForwardTable rows={loadForward(owner, repo)} />
      </Section>
    </>
  );
}
