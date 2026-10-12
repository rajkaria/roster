// The hero's backdrop: a field of task cells, a few of which light up and fade like grades landing. Positions and
// timings come from a fixed seed, so the server always renders the same field and nothing hydrates.
import type { CSSProperties } from "react";

const COLS = 30;
const ROWS = 14;
const LIT = 0.15;

const SEEDS = { hero: 11, cta: 29 } as const;

export function Field({ variant = "hero" }: { variant?: keyof typeof SEEDS }) {
  let s: number = SEEDS[variant];
  const next = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const cells: (CSSProperties & { tone: string } | null)[] = [];
  for (let i = 0; i < COLS * ROWS; i++) {
    if (next() > LIT) {
      cells.push(null);
      continue;
    }
    const tone = next() < 0.1 ? "old" : "new";
    cells.push({ tone, animationDelay: `${(next() * 12).toFixed(2)}s`, animationDuration: `${(5 + next() * 7).toFixed(2)}s` });
  }
  return (
    <div className="field" aria-hidden="true">
      {cells.map((c, i) => {
        if (!c) return <i key={i} />;
        const { tone, ...style } = c;
        return <i key={i} className={`lit ${tone}`} style={style} />;
      })}
    </div>
  );
}
