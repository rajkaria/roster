import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";
import { GITHUB } from "@/components/LandingData";
import { loadForwardFile, loadPreregFile, type Forward, type ForwardRow } from "@/lib/forward";

export const metadata: Metadata = {
  title: "Experiment · Roster",
  description:
    "The pre-registered forward run: the frozen backlog, and every paired task as it lands.",
};

const DATA = join(process.cwd(), "public", "data");
const PREREG_URL = `${GITHUB}/blob/main/experiments/PREREGISTRATION.md`;

const pass = (v: boolean) => (v ? "pass" : "fail");
const usd = (v: number | null) => (v === null ? <span className="na">n/a</span> : `$${v.toFixed(2)}`);

function Pairs({ rows, summary }: { rows: ForwardRow[]; summary: Forward["summary"] }) {
  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: "1.15rem", margin: "0 0 12px" }}>Pairs</h2>
      {summary && (
        <div className="banner" style={{ color: "var(--fg)" }}>
          {summary.wording}
          <span className="sub">
            {summary.n} paired tasks · {rows.length} shown
            {summary.skipped > 0
              ? ` · ${summary.skipped} malformed row${summary.skipped === 1 ? "" : "s"} skipped`
              : ""}
          </span>
        </div>
      )}
      {rows.length === 0 ? (
        <div className="empty">No pairs have been graded yet.</div>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Task</th>
                <th>Old setup</th>
                <th>New setup</th>
                <th>Old cost</th>
                <th>New cost</th>
                <th>Excluded</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.task}-${i}`}>
                  <td>{r.task}</td>
                  <td>{pass(r.old)}</td>
                  <td>{pass(r.new)}</td>
                  <td className="num">{usd(r.costOld)}</td>
                  <td className="num">{usd(r.costNew)}</td>
                  <td>{r.excluded === undefined ? "none" : r.excluded}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Exclusions with no row in forward.json (excluded before pairing), with their written reason and amendment. */
function unpaired(forward: Forward | null): { task: string; reason: string; amendment: number | null }[] {
  const file = join(DATA, "self", "forward-exclusions.json");
  let json: unknown = null;
  try {
    json = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch {
    json = null;
  }
  const list = (json as { exclusions?: unknown } | null)?.exclusions;
  if (!Array.isArray(list)) return [];
  const shown = new Set((forward?.rows ?? []).map((r) => r.task));
  return list
    .filter((e): e is { task: string; reason: string; amendment?: unknown } => typeof e?.task === "string" && typeof e?.reason === "string")
    .filter((e) => !shown.has(e.task))
    .map((e) => ({ task: e.task, reason: e.reason, amendment: typeof e.amendment === "number" ? e.amendment : null }));
}

export default function ExperimentPage() {
  const forward = loadForwardFile(DATA);
  const notShown = unpaired(forward);
  const sha256 = loadPreregFile(DATA);

  return (
    <>
      <h1>The experiment</h1>
      <p className="lede">
        Roster built itself with several agent setups, reviewed its own sessions, and promoted one setup. Before
        that review ran, we froze a backlog of new tasks and their acceptance tests. This page reports the forward
        run: every frozen task, run through both the demoted and the promoted setup, graded blind. The
        hypotheses, tests and stop rules are fixed in{" "}
        <a href={PREREG_URL} rel="noopener noreferrer">PREREGISTRATION.md</a>.
      </p>
      {sha256 && (
        <p className="meta">Frozen backlog sha256: {sha256}</p>
      )}
      {forward === null ? (
        <div className="empty">The forward run has not started</div>
      ) : (
        <Pairs rows={forward.rows} summary={forward.summary} />
      )}
      {notShown.map((e) => (
        <p className="meta" key={e.task}>
          {e.task} is excluded and not shown: {e.reason}{e.amendment !== null && ` (amendment ${e.amendment})`}.
        </p>
      ))}
    </>
  );
}
