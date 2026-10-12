import type { Review } from "@/lib/types";
import { formatP, type ForwardResult } from "@/lib/result";
import { FORWARD_SETUPS, formatGenerated, frozenTasks, passedBy, sumSessions, type CostSummary, type TaskGrid as Grid } from "@/lib/landing";
import type { ReviewSummary } from "@/lib/reviews";
import { GITHUB, SELF_OWNER, SELF_REPO, landingTotals } from "./LandingData";
import { Arrow } from "./landing/Mark";
import { Field } from "./landing/Field";
import { Scoreboard } from "./landing/Scoreboard";
import { Ticker } from "./landing/Ticker";
import { TaskGrid } from "./landing/TaskGrid";
import { CostChart } from "./landing/CostChart";
import { RosterCards } from "./landing/RosterCards";

const BLOB = `${GITHUB}/blob/main`;
const ext = { rel: "noopener noreferrer", target: "_blank" } as const;

/** A numbered section heading. The number comes from a CSS counter, so sections can be reordered freely. */
function Head({ kicker, children, lede }: { kicker: string; children: React.ReactNode; lede?: React.ReactNode }) {
  return (
    <header className="sec-head" data-reveal>
      <p className="sec-kicker">{kicker}</p>
      <h2 className="sec-title">{children}</h2>
      {lede && <p className="sec-lede">{lede}</p>}
    </header>
  );
}

export function Hero({ forward, cost }: { forward: ForwardResult | null; cost: CostSummary | null }) {
  return (
    <section className="hero">
      <Field />
      <div className="wrap hero-inner">
        <div className="hero-copy">
          <p className="kicker">
            <span className={forward ? "pulse" : "pulse is-wait"} aria-hidden="true" />
            {forward ? "Forward test complete. The call held." : "Forward test running"}
          </p>
          <h1 className="display">
            Performance reviews for your <em>AI coding agents.</em>
          </h1>
          <p className="hero-lede">
            Roster is an agent that runs performance reviews for your AI coding agents. It reads the sessions they
            recorded, finds the setup that&apos;s quietly making your codebase worse, tests a better one on your own past
            tasks, and ships it only if nothing regresses.
          </p>
          <div className="ctas">
            <a className="btn btn-primary" href="/try">
              Try it on a repo <Arrow />
            </a>
            <a className="btn btn-ghost" href="/experiment">
              See the experiment
            </a>
          </div>
        </div>
        <Scoreboard forward={forward} cost={cost} />
      </div>
    </section>
  );
}

/** The run in numbers, every one read from the reports. */
export function NumbersTicker({ review, grid, forward }: { review: Review | null; grid: Grid; forward: ForwardResult | null }) {
  const items: string[] = [];
  if (review) {
    items.push(`${landingTotals(review).sessions} agent sessions reviewed`);
    items.push(`${review.setups.length} setups on the roster`);
  }
  if (grid.cells.length) items.push(`${frozenTasks(grid)} tasks frozen before the call`);
  if (forward) items.push(forward.wording);
  if (grid.cost) items.push(`cheaper in ${grid.cost.cheaperNew} of ${grid.cost.pairs} pairs`);
  items.push("every grading fix disclosed before the result was seen");
  items.push("graded against frozen acceptance tests");
  return <Ticker items={items} />;
}

const STEPS = [
  { name: "Read", text: "Every recorded agent session: prompts, tokens, model and the commit it made.", level: "" },
  { name: "Score", text: "What happened to each change: kept, reverted, or reworked by a person.", level: "A" },
  { name: "Replay", text: "The suspect's real past tasks, rerun at their parent commit and graded with hidden tests.", level: "B" },
  { name: "Gate", text: "A candidate is promoted only if nothing regresses. A tie with no signal is refused.", level: "" },
  { name: "Forward test", text: "New tasks, frozen before the decision, built by the old and the new setup side by side.", level: "C" },
  { name: "Ship", text: "Opens a pull request that switches the setup, only for repos that opt in.", level: "" },
];

const LEVELS = [
  {
    level: "A",
    name: "Observational",
    text: "Points at a suspect setup from what happened to its changes. On its own it proves nothing.",
  },
  {
    level: "B",
    name: "Controlled replay",
    text: "Reruns real past tasks under the current setup and the candidates, graded by hidden tests.",
  },
  {
    level: "C",
    name: "Pre-registered forward test",
    text: "Checks that the decision holds on work that did not exist yet when it was made.",
  },
];

export function HowItWorks({ onRepo }: { onRepo: Record<string, string | null> }) {
  return (
    <section className="sec" id="how">
      <div className="wrap">
        <Head
          kicker="How it works"
          lede="A setup is a coding-agent harness, a model and a rules file. Roster reviews setups the way you would review a team: by what their work did, not by what they claim."
        >
          From transcript to promotion, <em>with receipts.</em>
        </Head>
        <ol className="flow" data-reveal>
          {STEPS.map((s) => (
            <li key={s.name} className="flow-step">
              <span className="flow-node" aria-hidden="true" />
              <p className="flow-name">
                {s.name}
                {s.level && <span className="lvl">level {s.level}</span>}
              </p>
              <p className="flow-text">{s.text}</p>
            </li>
          ))}
        </ol>
        <div className="levels" data-reveal>
          {LEVELS.map((l) => (
            <article className="level" key={l.level} data-glow>
              <span className="level-letter" aria-hidden="true">
                {l.level}
              </span>
              <p className="level-name">
                <span className="sr-only">Level {l.level}: </span>
                {l.name}
              </p>
              <p className="level-text">{l.text}</p>
              {onRepo[l.level] && (
                <p className="level-proof">
                  <span>On this repo</span> {onRepo[l.level]}
                </p>
              )}
            </article>
          ))}
        </div>
        <p className="note" data-reveal>
          Every claim on a Roster page carries the evidence level behind it. A setup is never called worse on level A alone.
        </p>
      </div>
    </section>
  );
}

export function Experiment({
  started,
  forward,
  grid,
  sha,
}: {
  started: boolean;
  forward?: { n: number; wording: string } | null;
  grid: Grid;
  sha: string | null;
}) {
  const p = passedBy(grid.counts);
  const footnote = forward
    ? `${forward.n} valid pairs, ${forward.wording} (McNemar exact, two-sided). ${FORWARD_SETUPS.new.id} passed ${p.new}, ${FORWARD_SETUPS.old.id} passed ${p.old}. A blind diff judge only broke merge ties.`
    : "The forward run's pairs appear here as they are graded.";
  return (
    <section className="sec" id="experiment">
      <div className="wrap">
        <Head
          kicker="The experiment"
          lede={
            <>
              Roster built itself with several agent setups, reviewed them, and replaced {FORWARD_SETUPS.old.full} (
              {FORWARD_SETUPS.old.id}) with {FORWARD_SETUPS.new.full} ({FORWARD_SETUPS.new.id}). Before it made that call,
              we froze a backlog of new tasks and their acceptance tests. Then each task was built twice, once by each
              setup, and graded against those frozen tests.
            </>
          }
        >
          Every frozen task, <em>built twice.</em>
        </Head>
        {grid.cells.length ? (
          <TaskGrid cells={grid.cells} counts={grid.counts} footnote={footnote} />
        ) : (
          <div className="empty">forward run not started.</div>
        )}
        <div className="seal" data-reveal>
          <div className="seal-badge" aria-hidden="true">
            <span>frozen</span>
          </div>
          <div className="seal-body">
            <p className="seal-title">Sealed before the review ran</p>
            <p className="seal-text">
              The backlog and its tests were hashed and committed in{" "}
              <a href={`${BLOB}/experiments/FREEZE.txt`} {...ext}>
                FREEZE.txt
              </a>
              . Hypotheses, tests and stop rules are fixed in{" "}
              <a href={`${BLOB}/experiments/PREREGISTRATION.md`} {...ext}>
                PREREGISTRATION.md
              </a>
              , and every later grading fix is a dated amendment, written before the affected result was seen. Results get
              published whatever they show.
            </p>
            {sha && <code className="seal-hash">sha256 {sha}</code>}
            <p className="seal-status">
              Status:{" "}
              {forward ? (
                <>
                  forward run complete: {forward.n} valid pairs, {forward.wording}.{" "}
                  <a href="/experiment">See every pair</a>
                </>
              ) : started ? (
                <>
                  forward run started. <a href="/experiment">See the pairs so far</a>
                </>
              ) : (
                "forward run not started."
              )}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Costs({ grid }: { grid: Grid }) {
  if (!grid.costPairs.length) return null;
  const c = grid.cost;
  return (
    <section className="sec" id="cost">
      <div className="wrap">
        <Head
          kicker="The bill"
          lede={
            c ? (
              <>
                The promoted setup cost less on every pair: cheaper in {c.cheaperNew} of {c.pairs}. We give the two medians
                side by side rather than a ratio (Wilcoxon signed-rank, {formatP(c.p)}).
              </>
            ) : undefined
          }
        >
          Better, and <em>cheaper every time.</em>
        </Head>
        <CostChart pairs={grid.costPairs} cost={grid.cost} />
      </div>
    </section>
  );
}

const LABEL_TEXT: Record<Review["label"], (r: Review) => string> = {
  no_suspect: () => "Level A finds no suspect, so this review alone calls no setup worse.",
  suspect: (r) => `Level A flags ${r.suspect ?? "a setup"} as a suspect. Only a replay can confirm it.`,
  insufficient_data: () => "Level A has too little data to name a suspect yet.",
};

export function OwnReview({ review, corpus }: { review: Review | null; corpus: ReviewSummary[] }) {
  const href = `/r/${SELF_OWNER}/${SELF_REPO}`;
  const others = corpus.filter((c) => `${c.owner}/${c.repo}` !== `${SELF_OWNER}/${SELF_REPO}`);
  const otherSessions = sumSessions(others);
  const totals = review ? landingTotals(review) : null;
  return (
    <section className="sec" id="roster">
      <div className="wrap">
        <Head
          kicker="The roster"
          lede={
            review ? (
              <>
                The coding agents that built Roster, reviewed by Roster.{" "}
                <span className="badge" title="Evidence level">
                  level {review.evidence_level}
                </span>{" "}
                {LABEL_TEXT[review.label](review)}
              </>
            ) : undefined
          }
        >
          Our own AI team&apos;s <em>review.</em>
        </Head>
        {review && totals ? (
          <>
            <RosterCards review={review} />
            <p className="roster-foot" data-reveal>
              {review.repo}, generated {formatGenerated(review.generated_at)}. {totals.sessions} sessions, {totals.spend} of spend.{" "}
              <a href={href}>
                Read the full review <Arrow />
              </a>
            </p>
          </>
        ) : (
          <div className="empty">This repo&apos;s review has not been published yet.</div>
        )}
        {others.length ? (
          <div className="corpus" data-reveal>
            <p className="corpus-title">
              Also reviewed in public: {others.length} repos, {otherSessions} sessions.{" "}
              <a href="/r">All reviews</a>
            </p>
            <ul className="corpus-list">
              {others.map((c) => (
                <li key={c.href}>
                  <a href={c.href}>
                    <span className="corpus-owner">{c.owner}/</span>
                    <b>{c.repo}</b>
                    <span className="corpus-n">{c.sessions}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export type BuiltWithData = {
  traces: { before: string; after: string } | null;
  cfo: { plan: string | null; book: string | null };
};

const ENTIRE_SESSIONS = `https://entire.io/gh/${SELF_OWNER}/${SELF_REPO}`;
const CHECKPOINTS = `${GITHUB}/tree/entire/checkpoints/v1`;

export function BuiltWith({ data = { traces: null, cfo: { plan: null, book: null } } }: { data?: BuiltWithData }) {
  return (
    <section className="sec" id="built-with">
      <div className="wrap">
        <Head kicker="Built with">
          Entire, neatlogs and cfo.ai, <em>each doing real work.</em>
        </Head>
        <div className="tools" data-reveal>
          <article className="tool" data-glow>
            <p className="tool-role">The input</p>
            <p className="tool-name">
              <a href="https://entire.io" {...ext}>
                Entire
              </a>
            </p>
            <p className="tool-text">
              Records every coding agent session with its prompts, tokens and commit, and Roster reads those records as its
              input. It recorded every agent session that built Roster.
            </p>
            <p className="tool-links">
              <a href={ENTIRE_SESSIONS} {...ext}>
                Sessions on entire.io
              </a>
              <a href={CHECKPOINTS} {...ext}>
                Checkpoint branch
              </a>
            </p>
          </article>
          <article className="tool" data-glow>
            <p className="tool-role">The trace</p>
            <p className="tool-name">
              <a href="https://neatlogs.com" {...ext}>
                neatlogs
              </a>
            </p>
            <p className="tool-text">Traces Roster&apos;s runs, from ingest to each replay attempt and gate decision.</p>
            {data.traces && (
              <p className="tool-text tool-small">
                The first and second gate calls on the same tasks are traces <code>{data.traces.before}</code> and{" "}
                <code>{data.traces.after}</code>, re-emitted from the recorded results, so span timings are emission times.
              </p>
            )}
          </article>
          <article className="tool" data-glow>
            <p className="tool-role">The books</p>
            <p className="tool-name">
              <a href="https://cfo.ai" {...ext}>
                cfo.ai
              </a>
            </p>
            <p className="tool-text">
              Holds the company plan, and Roster books the AI team&apos;s spend per setup into it as a department.
            </p>
            {(data.cfo.plan || data.cfo.book) && (
              <p className="tool-links">
                {data.cfo.plan && (
                  <a href={data.cfo.plan} {...ext}>
                    Business plan
                  </a>
                )}
                {data.cfo.book && (
                  <a href={data.cfo.book} {...ext}>
                    AI workforce book
                  </a>
                )}
              </p>
            )}
          </article>
        </div>
      </div>
    </section>
  );
}

export function FinalCta() {
  return (
    <section className="cta">
      <Field variant="cta" />
      <div className="wrap cta-inner" data-reveal>
        <h2 className="display cta-title">
          Put your AI team <em>up for review.</em>
        </h2>
        <p className="cta-lede">
          Paste a public GitHub repo to find its review, or run the CLI on a repo you trust. Every number on this page is
          read from a report file in the repo.
        </p>
        <div className="ctas">
          <a className="btn btn-primary" href="/try">
            Try it on a repo <Arrow />
          </a>
          <a className="btn btn-ghost" href={GITHUB} {...ext}>
            Read the code
          </a>
        </div>
        <p className="cta-small">
          <a href={`${GITHUB}#limits`} {...ext}>
            The limits, stated plainly
          </a>
        </p>
      </div>
    </section>
  );
}
