"use client";
// Every frozen task as one cell, coloured by which setup passed it. Hovering, focusing or tapping a cell shows that
// pair in the readout. Cells and counts come from lib/landing.ts; this component only draws them.
import { useState, type CSSProperties } from "react";
import { FORWARD_SETUPS, type Outcome, type TaskCell } from "@/lib/landing-shared";

const OUTCOME_TEXT: Record<Outcome, string> = {
  newOnly: `only ${FORWARD_SETUPS.new.id} passed`,
  oldOnly: `only ${FORWARD_SETUPS.old.id} passed`,
  both: "both passed",
  neither: "neither passed",
  excluded: "excluded",
};

const LEGEND: { outcome: Outcome; text: string }[] = [
  { outcome: "newOnly", text: `Only ${FORWARD_SETUPS.new.id} · ${FORWARD_SETUPS.new.name} passed` },
  { outcome: "oldOnly", text: `Only ${FORWARD_SETUPS.old.id} · ${FORWARD_SETUPS.old.name} passed` },
  { outcome: "both", text: "Both passed" },
  { outcome: "neither", text: "Neither passed" },
  { outcome: "excluded", text: "Excluded, with a written reason" },
];

const money = (v: number | null) => (v === null ? "not priced" : `$${v.toFixed(3)}`);
const passed = (c: TaskCell, side: "old" | "new"): boolean | null => {
  if (c.outcome === "excluded") return null;
  if (c.outcome === "both") return true;
  if (c.outcome === "neither") return false;
  return side === "new" ? c.outcome === "newOnly" : c.outcome === "oldOnly";
};

function describe(c: TaskCell): string {
  if (c.outcome === "excluded") return `${c.task}: excluded, ${c.reason ?? "see the experiment page"}`;
  return `${c.task}: ${OUTCOME_TEXT[c.outcome]}`;
}

function Side({ cell, side }: { cell: TaskCell; side: "old" | "new" }) {
  const s = FORWARD_SETUPS[side];
  const p = passed(cell, side);
  return (
    <div className={`readout-side is-${side}`}>
      <span className="readout-who">
        <b>{s.id}</b> {s.name}
      </span>
      <span className={`readout-pf ${p === null ? "" : p ? "pf-pass" : "pf-fail"}`}>{p === null ? "n/a" : p ? "pass" : "fail"}</span>
      <span className="readout-cost">{money(side === "new" ? cell.costNew : cell.costOld)}</span>
    </div>
  );
}

export function TaskGrid({ cells, counts, footnote }: { cells: TaskCell[]; counts: Record<Outcome, number>; footnote: string }) {
  const [active, setActive] = useState<number | null>(null);
  const cell = active === null ? null : cells[active] ?? null;
  return (
    <div className="tg" data-reveal>
      <ol className="tg-cells" aria-label="Every frozen task and how each setup did" onMouseLeave={() => setActive(null)}>
        {cells.map((c, i) => (
          <li key={c.task} style={{ "--i": i } as CSSProperties}>
            <button
              type="button"
              className={`tg-cell t-${c.outcome}${active === i ? " is-active" : ""}`}
              aria-label={describe(c)}
              aria-pressed={active === i}
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onClick={() => setActive(i)}
            >
              <span className="tg-id">{c.task}</span>
              <span className="tg-dots" aria-hidden="true">
                <span className={`tg-dot d-old${passed(c, "old") ? " on" : ""}`} />
                <span className={`tg-dot d-new${passed(c, "new") ? " on" : ""}`} />
              </span>
            </button>
          </li>
        ))}
      </ol>
      <aside className="tg-side">
        <div className="readout" aria-live="polite">
          {cell ? (
            <>
              <p className="readout-title">
                <span className="readout-task">{cell.task}</span>
                <span className={`chip t-${cell.outcome}`}>{OUTCOME_TEXT[cell.outcome]}</span>
              </p>
              {cell.outcome === "excluded" ? (
                <p className="readout-why">
                  {cell.reason}
                  {cell.amendment !== undefined && ` (amendment ${cell.amendment})`}.
                </p>
              ) : (
                <>
                  <Side cell={cell} side="new" />
                  <Side cell={cell} side="old" />
                </>
              )}
            </>
          ) : (
            <p className="readout-hint">Hover or tap a task to see both runs of it.</p>
          )}
        </div>
        <ul className="legend">
          {LEGEND.map((l) => (
            <li key={l.outcome}>
              <span className={`sw t-${l.outcome}`} aria-hidden="true" />
              <span className="legend-text">{l.text}</span>
              <span className="legend-n">{counts[l.outcome]}</span>
            </li>
          ))}
        </ul>
        <p className="tg-foot">{footnote}</p>
      </aside>
    </div>
  );
}
