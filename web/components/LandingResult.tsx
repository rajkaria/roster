import type { Result } from "@/lib/result";
import { GITHUB } from "./LandingData";

const PREREG_URL = `${GITHUB}/blob/main/experiments/PREREGISTRATION.md`;

export function LandingResult({ result }: { result: Result }) {
  const { forward: f, v1, v2 } = result;
  return (
    <section className="land">
      <h2 className="land-h2">The result</h2>
      {f ? (
        <>
          <p className="meta">{f.wording}</p>
          <div className="scroll">
            <table className="compact">
              <tbody>
                <tr><td>Only the new setup passed</td><td className="num">{f.newOnly}</td></tr>
                <tr><td>Only the old setup passed</td><td className="num">{f.oldOnly}</td></tr>
                <tr><td>Both passed</td><td className="num">{f.both}</td></tr>
                <tr><td>Neither passed</td><td className="num">{f.neither}</td></tr>
                <tr><td>Valid pairs</td><td className="num">{f.n}</td></tr>
                <tr><td>McNemar exact p</td><td className="num">{f.p}</td></tr>
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="empty">forward run in progress</div>
      )}
      <div className="scroll">
        <table className="compact">
          <thead>
            <tr><th>Call</th><th>Verdict</th><th>Why</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Original gate (v1)</td>
              <td>{v1 ? v1.verdict : "unavailable"}</td>
              <td>{v1 ? v1.reasons.join("; ") : ""}</td>
            </tr>
            <tr>
              <td>Revised gate (v2), same tasks</td>
              <td>{v2 ? v2.verdict : "unavailable"}</td>
              <td>
                {v2 ? v2.reasons.join("; ") : ""}
                {v2?.hiddenPass
                  ? ` (hidden tests passed: incumbent ${v2.hiddenPass.incumbent}, candidate ${v2.hiddenPass.candidate})`
                  : ""}
              </td>
            </tr>
            <tr>
              <td>Forward test of v1&apos;s call</td>
              <td>{f ? f.wording : "forward run in progress"}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      <p className="meta">
        <a href="/experiment">The experiment page</a> ·{" "}
        <a href={PREREG_URL} rel="noopener noreferrer">PREREGISTRATION.md</a>
      </p>
    </section>
  );
}
