// The landing page's client-safe pieces: setup names, cell types and formatting. No node: imports, so client
// components (the task grid) can use them; lib/landing.ts re-exports all of it for server code and tests.

/**
 * The forward run's two setups. `old` is the demoted incumbent, `new` the promoted candidate. Names follow
 * setups/B.json and setups/candidates/E.json; tests/web-landing-graphics.test.ts checks they still match.
 */
export const FORWARD_SETUPS = {
  old: { id: "B", name: "Sonnet 5.5", full: "Claude Code + Sonnet 5.5" },
  new: { id: "E", name: "DeepSeek Flash", full: "Claude Code on DeepSeek Flash" },
} as const;

export type Outcome = "newOnly" | "oldOnly" | "both" | "neither" | "excluded";

export interface TaskCell {
  task: string;
  outcome: Outcome;
  costOld: number | null;
  costNew: number | null;
  /** The written exclusion reason, for excluded tasks only. */
  reason?: string;
  amendment?: number;
}

/** "$0.020": three decimals, the precision the cost medians are published at. */
export const usd3 = (n: number): string => `$${n.toFixed(3)}`;
