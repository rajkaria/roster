import type { Metadata } from "next";
import { TryForm } from "@/components/TryForm";

export const metadata: Metadata = {
  title: "Try · Roster",
  description: "Paste a GitHub repo to see its Roster review, if one exists.",
};

export default function TryPage() {
  return (
    <>
      <h1>Try</h1>
      <p className="lede">Paste a public GitHub repo. If Roster has already reviewed it, you get the link.</p>
      <p className="meta">Evidence: level A: observational. Nothing runs when you submit.</p>
      <TryForm />
    </>
  );
}
