import type { Metadata } from "next";
import { TryForm } from "@/components/TryForm";

export const metadata: Metadata = {
  title: "Try · Roster",
  description: "Paste a public GitHub repo whose coding agents record sessions with Entire, and Roster reviews it live.",
};

/** Live reviews are on when the deployment has the dispatch token (read at build time, like the rest of the page). */
const LIVE = Boolean(process.env.ROSTER_DISPATCH_TOKEN?.trim());

export default function TryPage() {
  return (
    <>
      <h1>Try</h1>
      {LIVE ? (
        <>
          <p className="lede">
            Paste a public GitHub repo whose coding agents record their sessions with <a href="https://entire.io">Entire</a>.
            Roster reviews it live and publishes the review here, usually within a few minutes.
          </p>
          <p className="meta">
            Evidence: level A, observational. No model calls, and nothing from the repo is run. Each review runs on a
            GitHub Actions runner and is committed to{" "}
            <a href="https://github.com/rajkaria/roster-reviews">rajkaria/roster-reviews</a>, so every result can be checked.
          </p>
        </>
      ) : (
        <>
          <p className="lede">Paste a public GitHub repo. If Roster has already reviewed it, you get the link.</p>
          <p className="meta">Evidence: level A: observational. Nothing runs when you submit.</p>
        </>
      )}
      <TryForm />
    </>
  );
}
