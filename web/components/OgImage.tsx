// Renders the 1200x630 social card for app/opengraph-image.tsx and app/twitter-image.tsx.
import { ImageResponse } from "next/og";
import { ogCardFile } from "@/lib/og";

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_ALT = "Roster: performance reviews for your AI coding agents, with the pre-registered forward test result";

const C = { bg: "#0b0c0e", panel: "#121418", line: "#23262d", fg: "#e6e8eb", dim: "#8b919b", accent: "#7cc4ff" };

export function ogImage(): ImageResponse {
  const card = ogCardFile();
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: C.bg, color: C.fg, padding: "64px 72px", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 40, fontWeight: 700, color: C.accent }}>Roster</div>
          <div style={{ display: "flex", fontSize: 44, marginTop: 12, lineHeight: 1.2 }}>Performance reviews for your AI coding agents</div>
        </div>
        {card.result ? (
          <div style={{ display: "flex", flexDirection: "column", background: C.panel, border: `2px solid ${C.line}`, borderRadius: 20, padding: "32px 40px" }}>
            <div style={{ display: "flex", fontSize: 26, color: C.dim }}>Promoted setup vs the old one · {card.pairs}</div>
            <div style={{ display: "flex", fontSize: 64, fontWeight: 700, marginTop: 8 }}>{card.result}</div>
            {card.cost && <div style={{ display: "flex", fontSize: 30, color: C.accent, marginTop: 8 }}>{card.cost}</div>}
          </div>
        ) : (
          <div style={{ display: "flex", fontSize: 32, color: C.dim }}>Find the agent setup that is quietly making your codebase worse.</div>
        )}
      </div>
    ),
    OG_SIZE,
  );
}
