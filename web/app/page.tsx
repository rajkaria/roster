import { join } from "node:path";
import type { Metadata } from "next";
import "./landing.css";
import { listReviews, loadReview } from "@/lib/reviews";
import { loadPreregFile } from "@/lib/forward";
import { taskGridFile } from "@/lib/landing";
import { SELF_OWNER, SELF_REPO, builtWithData, forwardStarted, landingTotals } from "@/components/LandingData";
import {
  BuiltWith,
  Costs,
  Experiment,
  FinalCta,
  Hero,
  HowItWorks,
  NumbersTicker,
  OwnReview,
} from "@/components/LandingSections";
import { LandingResult } from "@/components/LandingResult";
import { Motion } from "@/components/landing/Motion";
import { loadResultFile } from "@/lib/result";

const TITLE = "Roster: performance reviews for your AI coding agents";
const DESCRIPTION =
  "Roster finds the agent setup that is quietly making your codebase worse, tests a better one on your own past tasks, and ships it only if nothing regresses.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website" },
};

const NO_SUSPECT_SHORT = { no_suspect: "no suspect named", suspect: "a suspect named", insufficient_data: "not enough data yet" };

export default function Home() {
  const data = join(process.cwd(), "public", "data");
  const review = loadReview(SELF_OWNER, SELF_REPO);
  const started = forwardStarted(data);
  const result = loadResultFile(data);
  const grid = taskGridFile(data);
  const sha = loadPreregFile(data);
  const corpus = listReviews(data);
  const onRepo = {
    A: review ? `${landingTotals(review).sessions} sessions read, ${NO_SUSPECT_SHORT[review.label]}.` : null,
    B: result.v2 ? `the v2 gate's call on replayed tasks: ${result.v2.verdict}.` : null,
    C: result.forward ? `${result.forward.wording}.` : null,
  };
  return (
    <div className="lp">
      <Motion />
      <Hero forward={result.forward} cost={grid.cost} />
      <NumbersTicker review={review} grid={grid} forward={result.forward} />
      <HowItWorks onRepo={onRepo} />
      <Experiment started={started} forward={result.forward} grid={grid} sha={sha} />
      <Costs grid={grid} />
      <LandingResult result={result} />
      <OwnReview review={review} corpus={corpus} />
      <BuiltWith data={builtWithData(data)} />
      <FinalCta />
    </div>
  );
}
