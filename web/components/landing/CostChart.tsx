// What each valid pair cost on each side, one row per task, most expensive old run first. The new setup's dot
// slides left from the old cost to its own when the chart scrolls into view. Drawn in HTML so labels stay
// legible at phone width.
import type { CSSProperties } from "react";
import { FORWARD_SETUPS, axisMax, usd3, type CostPair, type CostSummary } from "@/lib/landing";

const STEP = 0.1;

export function CostChart({ pairs, cost }: { pairs: CostPair[]; cost: CostSummary | null }) {
  if (pairs.length === 0) return null;
  const max = axisMax(pairs, STEP);
  const at = (v: number) => `${((v / max) * 100).toFixed(3)}%`;
  const ticks = Array.from({ length: Math.round(max / STEP) + 1 }, (_, k) => k * STEP);
  return (
    <figure className="cc" data-reveal>
      <div className="cc-plot">
        {ticks.map((t) => (
          <span key={t} className="cc-grid" style={{ left: at(t) }} aria-hidden="true" />
        ))}
        {cost && (
          <>
            <span className="cc-med is-old" style={{ left: at(cost.medianOld) }}>
              <span className="cc-med-label">
                {FORWARD_SETUPS.old.id} median {usd3(cost.medianOld)}
              </span>
            </span>
            <span className="cc-med is-new" style={{ left: at(cost.medianNew) }}>
              <span className="cc-med-label">
                {FORWARD_SETUPS.new.id} median {usd3(cost.medianNew)}
              </span>
            </span>
          </>
        )}
        <ol className="cc-rows" aria-label="Cost per task, old setup and new setup">
          {pairs.map((p, i) => (
            <li
              key={p.task}
              className="cc-row"
              style={{ "--o": at(p.old), "--n": at(p.new), "--i": i } as CSSProperties}
              title={`${p.task}: ${FORWARD_SETUPS.old.id} ${usd3(p.old)}, ${FORWARD_SETUPS.new.id} ${usd3(p.new)}`}
            >
              <span className="sr-only">
                {p.task}: {FORWARD_SETUPS.old.full} {usd3(p.old)}, {FORWARD_SETUPS.new.full} {usd3(p.new)}
              </span>
              <span className="cc-bar" aria-hidden="true" />
              <span className="cc-dot is-old" aria-hidden="true" />
              <span className="cc-dot is-new" aria-hidden="true" />
            </li>
          ))}
        </ol>
      </div>
      <div className="cc-axis" aria-hidden="true">
        {ticks.map((t) => (
          <span key={t} style={{ left: at(t) }}>
            ${t.toFixed(2)}
          </span>
        ))}
      </div>
      <figcaption className="cc-cap">
        <span className="cc-key">
          <span className="cc-dot is-old" /> {FORWARD_SETUPS.old.full}
        </span>
        <span className="cc-key">
          <span className="cc-dot is-new" /> {FORWARD_SETUPS.new.full}
        </span>
        <span className="cc-key-note">Cost per task, re-priced from each run&apos;s tokens (amendment 10).</span>
      </figcaption>
    </figure>
  );
}
