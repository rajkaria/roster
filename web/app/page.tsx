import { join } from "node:path";
import type { Metadata } from "next";
import { loadReview } from "@/lib/reviews";
import { SELF_OWNER, SELF_REPO, forwardStarted } from "@/components/LandingData";
import { Hero, OwnReview, HowItWorks, Experiment, BuiltWith } from "@/components/LandingSections";

const TITLE = "Roster: performance reviews for your AI coding agents";
const DESCRIPTION =
  "Roster finds the agent setup that is quietly making your codebase worse, tests a better one on your own past tasks, and ships it only if nothing regresses.";

export const metadata: Metadata = {
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website" },
};

export default function Home() {
  const review = loadReview(SELF_OWNER, SELF_REPO);
  const started = forwardStarted(join(process.cwd(), "public", "data"));
  return (
    <>
      <Hero />
      <OwnReview review={review} />
      <HowItWorks />
      <Experiment started={started} />
      <BuiltWith />
    </>
  );
}
