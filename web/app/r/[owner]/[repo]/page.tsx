import type { Metadata } from "next";
import { loadReview, listParams } from "@/lib/reviews";
import { loadLiveReview } from "@/lib/live-reviews";
import type { SetupRow } from "@/lib/types";
import { Section, SuspectCard, ReplaysTable, GateList, ForwardTable, Empty } from "@/components/Sections";
import { Detections, loadDetections } from "@/components/Detections";
import { loadReplays,loadGate, loadForward, loadOutcomes } from "./sidecar";
import { SELF_OWNER, SELF_REPO } from "@/components/LandingData";

// The reviews published at submission are prerendered from public/data. Any other repo renders on demand from
// its live review in rajkaria/roster-reviews (post-deadline, 13 Oct), if one exists.
export const dynamicParams = true;

export function generateStaticParams() {
  return listParams();
}

export async function generateMetadata({ params }: { params: Promise<{ owner: string; repo: string }> }): Promise<Metadata> {
  const { owner, repo } = await params;
  return {
    title: `${owner}/${repo} · Roster`,
    description: `Roster's review of the coding-agent setups that worked on ${owner}/${repo}.`,
  };
}

const pct = (v: number | null) => (v === null ? <span className="na">n/a</span> : `${(v * 100).toFixed(0)}%`);
const usd = (v: number | null) => (v === null ? <span className="na">n/a</span> : `$${v.toFixed(2)}`);

/** The review's own figure (mature sessions' cost over their survival), the number REVIEW.md and the book's ranking use. */
function costPerSurviving(s: SetupRow) {
  return s.cost_per_surviving_change;
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

/** This repo's own replays, gate calls and forward run are published under reports/self, shown on / and /experiment. */
function SelfPointer({ what }: { what: string }) {
  return (
    <div className="empty">
      This repo&apos;s {what} on the <a href="/">home page</a> and <a href="/experiment">/experiment</a>.
    </div>
  );
}

export default async function ReviewPage({ params }: { params: Promise<{ owner: string; repo: string }> }) {
  const { owner, repo } = await params;
  const frozen = loadReview(owner, repo);
  const live = frozen ? null : await loadLiveReview(owner, repo);
  const review = frozen ?? live?.review ?? null;
  const self = owner === SELF_OWNER && repo === SELF_REPO;

  if (!review) {
    return (
      <>
        <h1>{owner}/{repo}</h1>
        <div className="empty">
          No review has been published for this repo. <a href={`/try?repo=${encodeURIComponent(`${owner}/${repo}`)}`}>Review it live</a>.
        </div>
      </>
    );
  }

  const terciles = new Map((live ? live.outcomes : loadOutcomes(owner, repo)).map((o) => [o.session_id, o.tercile]));
  const notRunLive = (what: string) => (
    <Empty>
      {what} are not run for live reviews: a live review is level A only. They run with <code>roster run</code> and{" "}
      <code>roster forward</code>.
    </Empty>
  );

  return (
    <>
      <h1>{review.repo}</h1>
      <p className="meta">Generated {review.generated_at}</p>
      {live && (
        <div className="banner">
          Reviewed live by Roster on {review.generated_at.slice(0, 10)}, after the neatHack deadline. Evidence level A,
          observational: no model calls, and nothing from the repo is run.
          {live.status && (
            <>
              {" "}At commit <code>{live.status.target_head.slice(0, 7)}</code> · <a href={live.status.run_url}>run log</a> ·{" "}
              <a href={`https://github.com/rajkaria/roster-reviews/tree/main/reviews/${live.status.repo.replace("/", "__")}`}>raw data</a>
            </>
          )}
        </div>
      )}
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
        {live ? notRunLive("Replays") : self && loadReplays(owner, repo).length === 0 ? <SelfPointer what="replays and both gate calls are" /> : (
          <ReplaysTable replays={loadReplays(owner, repo)} terciles={terciles} setups={review.setups} />
        )}
      </Section>
      <Section title="Gate decisions" level="B">
        {live ? notRunLive("Gate decisions") : self && loadGate(owner, repo).length === 0 ? <SelfPointer what="gate decisions (the first promoted, the second rejected) are" /> : (
          <GateList rows={loadGate(owner, repo)} />
        )}
      </Section>
      {!live && <Detections rows={loadDetections(owner, repo)} />}
      <Section title="Forward" level="C">
        {live ? notRunLive("Forward tests") : self && loadForward(owner, repo).length === 0 ? <SelfPointer what="forward run is" /> : (
          <ForwardTable rows={loadForward(owner, repo)} />
        )}
      </Section>
    </>
  );
}
