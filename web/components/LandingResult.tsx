import { formatP, summariseReasons, type Result } from "@/lib/result";
import { FORWARD_SETUPS } from "@/lib/landing";
import { GITHUB } from "./LandingData";

const PREREG_URL = `${GITHUB}/blob/main/experiments/PREREGISTRATION.md`;

/** A verdict reads as a rubber stamp: green for promote or a held call, coral for reject, grey when unknown. */
const tone = (verdict: string | null): string =>
  verdict === null ? "stamp-none" : /reject|fail/i.test(verdict) ? "stamp-no" : "stamp-yes";

function Why({ reasons }: { reasons: string[] }) {
  return (
    <>
      {summariseReasons(reasons)}
      {reasons.length > 0 && (
        <details>
          <summary>raw reasons</summary>
          {reasons.join("; ")}
        </details>
      )}
    </>
  );
}

/** The story of the call: the v1 gate, the v2 gate on the same tasks, then the forward test on new ones. */
export function LandingResult({ result }: { result: Result }) {
  const { forward: f, v1, v2 } = result;
  const candidate = `${FORWARD_SETUPS.new.id} · ${FORWARD_SETUPS.new.name}`;
  return (
    <section className="sec" id="the-call">
      <div className="wrap">
        <header className="sec-head" data-reveal>
          <p className="sec-kicker">The call</p>
          <h2 className="sec-title">
            Right call, wrong reason. <em>Then the proof.</em>
          </h2>
          <p className="sec-lede">
            Roster&apos;s first gate promoted {candidate} without a real quality signal. We disclosed that, fixed the
            gate, and let a pre-registered test on brand-new work decide.
          </p>
        </header>
        <ol className="calls" data-reveal>
          <li className="call">
            <p className="call-step">Original gate (v1), replayed past tasks</p>
            <span className={`stamp ${tone(v1?.verdict ?? null)}`}>{v1 ? v1.verdict : "unavailable"}</span>
            <div className="call-why">{v1 ? <Why reasons={v1.reasons} /> : null}</div>
            <p className="call-note">Both setups tied with no hidden-test signal, so the cheaper one won.</p>
          </li>
          <li className="call">
            <p className="call-step">Revised gate (v2), same tasks</p>
            <span className={`stamp ${tone(v2?.verdict ?? null)}`}>{v2 ? v2.verdict : "unavailable"}</span>
            <div className="call-why">
              {v2 ? <Why reasons={v2.reasons} /> : null}
              {v2?.hiddenPass && !v2.reasons.some((r) => r.startsWith("hidden_pass"))
                ? ` (hidden tests passed: incumbent ${v2.hiddenPass.incumbent}, candidate ${v2.hiddenPass.candidate})`
                : ""}
            </div>
            <p className="call-note">Replaying past tasks turned out to be a weak signal, and the stricter gate refused.</p>
          </li>
          <li className="call is-final">
            <p className="call-step">Forward test of v1&apos;s call, new frozen tasks</p>
            <span className={`stamp ${f ? "stamp-yes" : "stamp-none"}`}>{f ? "held" : "pending"}</span>
            <div className="call-why">{f ? `${f.wording} (${f.n} valid pairs, McNemar exact ${formatP(f.p)})` : "forward run in progress"}</div>
            <p className="call-note">The pre-registered forward test is the strong signal, and it backs the promotion.</p>
          </li>
        </ol>
        <p className="call-links" data-reveal>
          <a href="/experiment">The experiment page</a>
          <a href={PREREG_URL} rel="noopener noreferrer" target="_blank">
            PREREGISTRATION.md
          </a>
        </p>
      </div>
    </section>
  );
}
