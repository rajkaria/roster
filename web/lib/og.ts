// The social card's text (og:image / twitter:image). Everything comes from the published forward.json, the same
// file the landing result and /experiment read: the result sentence verbatim, and the cost line computed from the
// comparison's pairs (excluded rows left out, as in the summary's n).
import { join } from "node:path";
import { loadForward, loadForwardFile, type Forward } from "./forward";

export interface OgCard {
  /** forward.json's published sentence, verbatim, e.g. "11 vs 1 passed, p = 0.006". */
  result: string | null;
  /** "35 pre-registered task pairs" from the summary's n. */
  pairs: string | null;
  /** "cheaper in 35 of 35 pairs, median $0.020 vs $0.148", over pairs priced on both sides. */
  cost: string | null;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function ogCardOf(forward: Forward | null): OgCard {
  if (!forward?.summary) return { result: null, pairs: null, cost: null };
  const priced = forward.rows.filter(
    (r): r is typeof r & { costOld: number; costNew: number } => r.excluded === undefined && r.costOld !== null && r.costNew !== null,
  );
  const cheaper = priced.filter((r) => r.costNew < r.costOld).length;
  const cost =
    priced.length === 0
      ? null
      : `cheaper in ${cheaper} of ${priced.length} pairs, median $${median(priced.map((r) => r.costNew)).toFixed(3)} vs $${median(priced.map((r) => r.costOld)).toFixed(3)}`;
  return { result: forward.summary.wording, pairs: `${forward.summary.n} pre-registered task pairs`, cost };
}

export const ogCard = (json: unknown): OgCard => ogCardOf(loadForward(json));
export const ogCardFile = (dataDir: string = join(process.cwd(), "public", "data")): OgCard => ogCardOf(loadForwardFile(dataDir));
