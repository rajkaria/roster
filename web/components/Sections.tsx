import type { Review, SetupRow } from "@/lib/types";
import type { ForwardRow, GateRow, ReplayRow } from "../app/r/[owner]/[repo]/sidecar";

const NA = <span className="na">n/a</span>;
const usd = (v: number | null | undefined) => (v == null ? NA : `$${v.toFixed(2)}`);
const yn = (v: boolean | null) => (v === null ? NA : v ? "pass" : "fail");

export function Section({ title, level, children }: { title: string; level: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: "1.15rem", margin: "0 0 12px" }}>
        {title} <span className="badge" title="Evidence level">level {level}</span>
      </h2>
      {children}
    </section>
  );
}

export const Empty = ({ children }: { children: React.ReactNode }) => <div className="empty">{children}</div>;

const Link = ({ href, children }: { href: string | null | undefined; children: React.ReactNode }) =>
  href ? <a href={href} rel="noopener noreferrer">{children}</a> : NA;

export function SuspectCard({ review }: { review: Review }) {
  const { label, suspect, odds_ratio: or, ci95, p_value: p } = review;
  if (!label) return <Empty>No suspect result in this review.</Empty>;
  const text =
    label === "suspect" ? "suspect (level A, observational)" : label === "no_suspect" ? "no suspect" : "insufficient data";
  return (
    <div className="banner" style={{ color: "var(--fg)" }}>
      <strong>{text}</strong>
      {label === "suspect" && suspect && <> · setup {suspect}</>}
      <div className="sub">
        Mantel–Haenszel odds ratio: {or == null ? "n/a" : or.toFixed(2)} · 95% CI:{" "}
        {ci95 ? `${ci95[0].toFixed(2)} to ${ci95[1].toFixed(2)}` : "n/a"} · p: {p == null ? "n/a" : p.toFixed(4)}
      </div>
    </div>
  );
}

export function ReplaysTable({
  replays, terciles, setups,
}: { replays: ReplayRow[]; terciles: Map<string, number | null>; setups: SetupRow[] }) {
  if (replays.length === 0) return <Empty>No replays have been run for this review.</Empty>;
  const name = (id: string) => setups.find((s) => s.setup_id === id)?.label ?? id;
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>Task</th><th>Tercile</th><th>Setup</th><th>Attempt</th><th>Hidden tests</th>
            <th>Verdict</th><th>Cost</th><th>Failure codes</th><th>Entire session</th><th>Trace</th>
          </tr>
        </thead>
        <tbody>
          {replays.map((r) => (
            <tr key={r.id}>
              <td className="num">{r.task_session_id}</td>
              <td className="num">{terciles.get(r.task_session_id) ?? NA}</td>
              <td>{name(r.setup_id)}</td>
              <td className="num">{r.attempt}</td>
              <td>{yn(r.hidden_pass)}</td>
              <td>{r.verdict}</td>
              <td className="num">{usd(r.cost_usd)}</td>
              <td className="num">{r.failure_codes.length ? r.failure_codes.join(", ") : "none"}</td>
              <td><Link href={r.entire_url}>entire.io</Link></td>
              <td><Link href={r.trace_url}>neatlogs</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function GateList({ rows }: { rows: GateRow[] }) {
  if (rows.length === 0) return <Empty>No gate decisions yet.</Empty>;
  return (
    <div className="scroll">
      <table>
        <thead><tr><th>Candidate</th><th>Verdict</th><th>Reasons</th><th>Trace</th></tr></thead>
        <tbody>
          {rows.map((g) => (
            <tr key={g.id}>
              <td>{g.candidate}</td>
              <td>{g.verdict}</td>
              <td style={{ whiteSpace: "normal", textAlign: "left" }}>{g.reasons.length ? g.reasons.join("; ") : NA}</td>
              <td><Link href={g.trace_url}>neatlogs</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ForwardTable({ rows }: { rows: ForwardRow[] }) {
  if (rows.length === 0) return <Empty>No forward-run data yet.</Empty>;
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr><th>Task</th><th>Old setup</th><th>New setup</th><th>Old</th><th>New</th><th>Old cost</th><th>New cost</th><th>Merged</th></tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f.task_id}>
              <td>{f.task_id}</td><td>{f.setup_old}</td><td>{f.setup_new}</td>
              <td>{yn(f.pass_old)}</td><td>{yn(f.pass_new)}</td>
              <td className="num">{usd(f.cost_old)}</td><td className="num">{usd(f.cost_new)}</td>
              <td>{f.merged ?? "none"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
