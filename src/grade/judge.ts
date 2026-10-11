// Blind diff-judge: input hides setup ids behind seeded X/Y labels, output is parsed strictly.

type Side = { setup: string; diff: string };

// mulberry32: one deterministic step is enough for a coin flip.
function coin(seed: number): boolean {
  let t = (seed >>> 0) + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296 < 0.5;
}

function redact(diff: string, ids: string[]): string {
  let out = diff;
  for (const id of ids) if (id) out = out.split(id).join("[setup]");
  return out;
}

export function blindPair(
  a: Side,
  b: Side,
  seed: number,
): { prompt: string; labels: Record<"X" | "Y", string> } {
  const [x, y] = coin(seed) ? [a, b] : [b, a];
  const ids = [a.setup, b.setup];
  const prompt = [
    "You are reviewing two candidate diffs written for the same task. Judge which one is the better change: correct, minimal, and in scope.",
    "",
    "=== DIFF X ===",
    redact(x.diff, ids),
    "=== END DIFF X ===",
    "",
    "=== DIFF Y ===",
    redact(y.diff, ids),
    "=== END DIFF Y ===",
    "",
    "Explain briefly, then end your answer with a final line of exactly one of:",
    "VERDICT: X",
    "VERDICT: Y",
    "VERDICT: TIE",
  ].join("\n");
  return { prompt, labels: { X: x.setup, Y: y.setup } };
}

export function parseVerdict(
  text: string,
  labels: Record<"X" | "Y", string>,
): { winner: string | "tie" | "unclear" } {
  const matches = [...text.matchAll(/^[ \t]*VERDICT:[ \t]*(X|Y|TIE)[ \t]*$/gim)];
  const last = matches[matches.length - 1];
  if (!last) return { winner: "unclear" };
  const v = last[1].toUpperCase();
  if (v === "TIE") return { winner: "tie" };
  return { winner: labels[v as "X" | "Y"] };
}
