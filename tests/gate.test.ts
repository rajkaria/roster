import { describe, expect, test } from "bun:test";
import { discordant, gate, MAX_ATTEMPTS } from "../src/gate/index.ts";
import type { GateResults } from "../src/gate/index.ts";
import { FailureCode } from "../src/types.ts";

// Compact attempt notation per task: "P" pass, "F" fail, "S" pass but off-scope, "E" F6 env error.
type Spec = Record<string, string>;

function rows(spec: Spec, cost = 1): GateResults {
  const out: GateResults = [];
  for (const [task, attempts] of Object.entries(spec)) {
    [...attempts].forEach((a, i) => {
      out.push({
        task_session_id: task,
        attempt: i + 1,
        hidden_pass: a === "P" || a === "S",
        scope_ok: a !== "S",
        cost_usd: cost,
        failure_codes: a === "E" ? [FailureCode.F6] : a === "S" ? [FailureCode.F7] : [],
      });
    });
  }
  return out;
}

interface Case {
  name: string;
  inc: Spec;
  cand: Spec;
  incCost?: number;
  candCost?: number;
  budget?: number;
  verdict: "promote" | "reject";
  regressions?: string[];
  ties?: "none" | "cheaper" | "incumbent";
  reason?: RegExp;
}

const CASES: Case[] = [
  { name: "more hidden passes, nothing regresses → promote", inc: { t1: "P", t2: "F" }, cand: { t1: "P", t2: "P" }, verdict: "promote", ties: "none", reason: /hidden_pass 2 > incumbent 1/ },
  { name: "fewer hidden passes → reject", inc: { t1: "P", t2: "P" }, cand: { t1: "P", t2: "F" }, verdict: "reject", regressions: ["t2"], reason: /hidden_pass 1 < incumbent 2/ },
  { name: "equal count but swaps a task → regression → reject", inc: { t1: "P", t2: "F" }, cand: { t1: "F", t2: "P" }, candCost: 0.5, verdict: "reject", regressions: ["t1"], reason: /1 regression/ },
  { name: "regression persists after reruns (majority fail) → reject", inc: { t1: "P", t2: "F" }, cand: { t1: "FPF", t2: "P" }, verdict: "reject", regressions: ["t1"] },
  { name: "regression disappears on rerun (majority pass) → promote", inc: { t1: "P", t2: "F" }, cand: { t1: "FPP", t2: "P" }, verdict: "promote", regressions: [] },
  { name: "incumbent flake fails majority → not a regression", inc: { t1: "PFF", t2: "P" }, cand: { t1: "F", t2: "P" }, candCost: 0.5, verdict: "promote", regressions: [], ties: "cheaper" },
  { name: "1–1 split is not a majority pass", inc: { t1: "P" }, cand: { t1: "PF" }, verdict: "reject", regressions: ["t1"] },
  { name: "any scope violation → reject", inc: { t1: "F", t2: "P" }, cand: { t1: "P", t2: "S" }, verdict: "reject", reason: /1 scope violation\(s\): t2/ },
  { name: "scope violation on any rerun still counts", inc: { t1: "P" }, cand: { t1: "PPS" }, candCost: 0.1, verdict: "reject", reason: /scope violation/ },
  { name: "over budget → reject", inc: { t1: "F" }, cand: { t1: "P" }, candCost: 6, budget: 5, verdict: "reject", reason: /> budget/ },
  { name: "exactly at budget → promote", inc: { t1: "F" }, cand: { t1: "P" }, candCost: 5, budget: 5, verdict: "promote" },
  { name: "tie, candidate cheaper → promote", inc: { t1: "P", t2: "F" }, cand: { t1: "P", t2: "F" }, incCost: 2, candCost: 1, verdict: "promote", ties: "cheaper" },
  { name: "tie, same cost → keep incumbent", inc: { t1: "P" }, cand: { t1: "P" }, verdict: "reject", ties: "incumbent", reason: /keep incumbent/ },
  { name: "tie, candidate pricier → keep incumbent", inc: { t1: "P" }, cand: { t1: "P" }, incCost: 1, candCost: 2, verdict: "reject", ties: "incumbent" },
  { name: "reruns don't inflate cost (mean per task)", inc: { t1: "P", t2: "F" }, cand: { t1: "FPP", t2: "F" }, incCost: 2, candCost: 1.5, verdict: "promote", ties: "cheaper" },
  { name: "candidate missing a task → reject", inc: { t1: "P", t2: "F" }, cand: { t1: "P" }, verdict: "reject", reason: /missing results for: t2/ },
  { name: "F6-only task is excluded, not a regression", inc: { t1: "P", t2: "F" }, cand: { t1: "EE", t2: "P" }, verdict: "promote", regressions: [] },
  { name: "F6 attempts don't count toward majority", inc: { t1: "P", t2: "F" }, cand: { t1: "EP", t2: "P" }, verdict: "promote" },
  { name: "empty replay set → reject", inc: {}, cand: {}, verdict: "reject", reason: /empty replay set/ },
];

describe("gate rules", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const r = gate(rows(c.inc, c.incCost ?? 1), rows(c.cand, c.candCost ?? 1), { budget: c.budget ?? 100 });
      expect(r.verdict).toBe(c.verdict);
      if (c.regressions) expect(r.regressions).toEqual(c.regressions);
      if (c.ties) expect(r.ties).toBe(c.ties);
      if (c.reason) expect(r.reasons.join("\n")).toMatch(c.reason);
      expect(r.reasons.length).toBeGreaterThan(0);
    });
  }

  test("unknown candidate cost → reject", () => {
    const cand = rows({ t1: "P" }).map((r) => ({ ...r, cost_usd: null }));
    const r = gate(rows({ t1: "F" }), cand, { budget: 100 });
    expect(r.verdict).toBe("reject");
    expect(r.cost.candidate).toBeNull();
    expect(r.reasons.join()).toMatch(/cost unknown/);
  });

  test("unknown incumbent cost on a tie → keep incumbent", () => {
    const inc = rows({ t1: "P" }).map((r) => ({ ...r, cost_usd: null }));
    const r = gate(inc, rows({ t1: "P" }, 0.1), { budget: 100 });
    expect(r.verdict).toBe("reject");
    expect(r.ties).toBe("incumbent");
  });

  test("is deterministic and order-independent", () => {
    const inc = rows({ t1: "P", t2: "F", t3: "PFP" });
    const cand = rows({ t1: "FPP", t2: "P", t3: "P" });
    const a = gate(inc, cand, { budget: 100 });
    const b = gate([...inc].reverse(), [...cand].reverse(), { budget: 100 });
    expect(b).toEqual(a);
    expect(a.verdict).toBe("promote");
  });
});

describe("discordant + rerun loop", () => {
  const CASES: { name: string; inc: Spec; cand: Spec; want: ReturnType<typeof discordant> }[] = [
    { name: "agreement → nothing to rerun", inc: { t1: "P", t2: "F" }, cand: { t1: "P", t2: "F" }, want: [] },
    { name: "split after 1 attempt → rerun both", inc: { t1: "P" }, cand: { t1: "F" }, want: [{ task_session_id: "t1", rerun: ["incumbent", "candidate"] }] },
    { name: "settled side (2/2) is not rerun", inc: { t1: "PP" }, cand: { t1: "F" }, want: [{ task_session_id: "t1", rerun: ["candidate"] }] },
    { name: "1–1 split needs a third attempt", inc: { t1: "PP" }, cand: { t1: "PF" }, want: [{ task_session_id: "t1", rerun: ["candidate"] }] },
    { name: "k = 3 reached → stop", inc: { t1: "PPP" }, cand: { t1: "FPF" }, want: [] },
    { name: "all-F6 task is resampled, not rerun", inc: { t1: "P" }, cand: { t1: "E" }, want: [] },
    { name: "missing candidate result → candidate needs an attempt", inc: { t1: "PP" }, cand: {}, want: [{ task_session_id: "t1", rerun: ["candidate"] }] },
  ];
  for (const c of CASES) {
    test(c.name, () => expect(discordant(rows(c.inc), rows(c.cand))).toEqual(c.want));
  }

  test("a regression that disappears on rerun: loop until settled, then promote", () => {
    // Candidate's later attempts pass t1; incumbent passes t1 consistently.
    const script: Record<"incumbent" | "candidate", Record<string, string>> = {
      incumbent: { t1: "PPP", t2: "FFF" },
      candidate: { t1: "FPP", t2: "PPP" },
    };
    const results = { incumbent: rows({ t1: "P", t2: "F" }), candidate: rows({ t1: "F", t2: "P" }) };

    expect(gate(results.incumbent, results.candidate, { budget: 100 }).regressions).toEqual(["t1"]);

    let rounds = 0;
    for (let d = discordant(results.incumbent, results.candidate); d.length > 0; d = discordant(results.incumbent, results.candidate)) {
      rounds++;
      expect(rounds).toBeLessThan(MAX_ATTEMPTS);
      for (const { task_session_id, rerun } of d) {
        for (const side of rerun) {
          const n = results[side].filter((r) => r.task_session_id === task_session_id).length;
          const next = rows({ [task_session_id]: script[side][task_session_id]![n]! })[0]!;
          results[side].push({ ...next, attempt: n + 1 });
        }
      }
    }
    expect(results.candidate.filter((r) => r.task_session_id === "t1").length).toBe(3);

    const r = gate(results.incumbent, results.candidate, { budget: 100 });
    expect(r.regressions).toEqual([]);
    expect(r.verdict).toBe("promote");
  });
});
