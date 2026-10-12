// This repo's own review as a roster: one badge per agent setup, with its sessions, spend, unattended rate and cost
// per surviving change. Values come from the published review.json through lib/landing.ts and LandingData.tsx.
import type { CSSProperties } from "react";
import { rosterCards } from "@/lib/landing";
import type { Review } from "@/lib/types";
import { landingRows } from "../LandingData";

const FAMILY: { test: RegExp; tone: string }[] = [
  { test: /opus/i, tone: "violet" },
  { test: /sonnet/i, tone: "amber" },
  { test: /haiku/i, tone: "teal" },
  { test: /deepseek/i, tone: "acid" },
];

const initials = (model: string) =>
  model
    .split(" ")
    .filter((w) => /^[A-Za-z]/.test(w))
    .map((w) => w.charAt(0))
    .join("")
    .slice(0, 2);

export function RosterCards({ review }: { review: Review }) {
  const cards = rosterCards(review);
  const rows = new Map(landingRows(review).map((r) => [r.setup_id, r]));
  return (
    <ul className="roster" data-reveal>
      {cards.map((c, i) => {
        const row = rows.get(c.setup_id);
        const tone = FAMILY.find((f) => f.test.test(c.model))?.tone ?? "grey";
        return (
          <li key={c.setup_id} className={`badge-card${c.cheapest ? " is-best" : ""}`} data-glow style={{ "--i": i } as CSSProperties}>
            {c.cheapest && <span className="ribbon">least per surviving change</span>}
            <div className="badge-top">
              <span className={`avatar tone-${tone}`} aria-hidden="true">
                {initials(c.model)}
              </span>
              <div>
                <p className="badge-name">{c.model}</p>
                <p className="badge-role">
                  {c.harness}
                  {c.rules && <> · {c.rules}</>}
                </p>
              </div>
            </div>
            <dl className="badge-stats">
              <div>
                <dt>Sessions</dt>
                <dd>{c.sessions}</dd>
              </div>
              <div>
                <dt>Spend</dt>
                <dd>{row?.spend ?? "n/a"}</dd>
              </div>
              <div>
                <dt>Unattended</dt>
                <dd>{row?.unattended ?? "n/a"}</dd>
              </div>
              <div>
                <dt>Per surviving change</dt>
                <dd>{c.costPerSurviving === null ? "n/a" : `$${c.costPerSurviving.toFixed(2)}`}</dd>
              </div>
            </dl>
            <div className="share" aria-hidden="true">
              <span style={{ width: `${(c.share * 100).toFixed(1)}%` }} />
            </div>
            <p className="share-label">{(c.share * 100).toFixed(0)}% of this repo&apos;s sessions</p>
          </li>
        );
      })}
    </ul>
  );
}
