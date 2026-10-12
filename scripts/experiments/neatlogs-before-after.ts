// neatlogs before/after. Emits review 1 (v1 replay, v1 gate) and review 1b (v2 replay, v2 gate) as two neatlogs
// traces with the compared numbers on the spans, so the comparison opens in neatlogs, not only in our reports.
// The spans are re-emitted now from the recorded results, so their timings are emission times, not the original
// runs'. Sources: review 1's replays in .roster/roster.db (plan review-1-p1) and its recorded decision
// (reports/self/review-1/decisions.json; the v1 gate code no longer exists); review 1b's replays.json, re-gated
// here with the current (v2) gate and checked against its recorded decision.json. Same 10 tests-track tasks and
// setups B (incumbent) and E (candidate) on both sides. Writes reports/self/neatlogs-before-after.json.
//
//   bun scripts/experiments/neatlogs-before-after.ts
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gate } from "../../src/gate/index.ts";
import { detect, type Detection } from "../../src/obs/detections.ts";
import { flushObs, initObs, type ObsSpan, setSession, withSpan } from "../../src/obs/index.ts";
import { DEFAULT_SPOOL_DIR } from "../../src/obs/spool.ts";

type Replay = {
  task_session_id: string;
  setup_id: string;
  attempt: number;
  cost_usd: number | null;
  /** null when the hidden tests did not run (review 1's v1 replay: hidden tests arrived without their support files). */
  hidden_pass: boolean | null;
  suite_pass: boolean;
  scope_ok: boolean;
  failure_codes: string[];
  verdict: string;
};

const OUT = "reports/self/neatlogs-before-after.json";
const SETUPS = ["B", "E"];
const after: Replay[] = JSON.parse(readFileSync("reports/self/review-1b/replays.json", "utf8"));
const afterDecisionRecorded = JSON.parse(readFileSync("reports/self/review-1b/decision.json", "utf8"));
const tasks = new Set(after.map((r) => r.task_session_id));

const db = new Database(".roster/roster.db", { readonly: true });
const before: Replay[] = (db.query("select json from replays where plan_id = 'review-1-p1'").all() as { json: string }[])
  .map((r) => JSON.parse(r.json) as Replay)
  .filter((r) => SETUPS.includes(r.setup_id) && tasks.has(r.task_session_id));
db.close();
const review1 = JSON.parse(readFileSync("reports/self/review-1/decisions.json", "utf8"));
const beforeDecision = review1.decisions.find((d: { candidate: string }) => d.candidate === "E");
if (!beforeDecision) throw new Error("review 1 has no decision for candidate E");

const detections = (rs: Replay[]): Detection[] =>
  detect({
    replays: rs.map((r) => ({
      task: r.task_session_id,
      setup: r.setup_id,
      suitePass: r.suite_pass,
      hiddenPass: r.hidden_pass === true,
      scopeOk: r.scope_ok,
      costUsd: r.cost_usd,
      failureCodes: r.failure_codes ?? [],
    })),
    incumbent: "B",
    unmappedLineShare: {},
  });

const count = (rs: Replay[], setup: string, f: (r: Replay) => boolean) => rs.filter((r) => r.setup_id === setup && f(r)).length;
const cost = (rs: Replay[], setup: string) => rs.filter((r) => r.setup_id === setup).reduce((a, r) => a + (r.cost_usd ?? 0), 0);

function numbers(rs: Replay[]) {
  const d = detections(rs);
  return {
    replays: rs.length,
    tasks: new Set(rs.map((r) => r.task_session_id)).size,
    hiddenRan: { B: count(rs, "B", (r) => r.hidden_pass !== null), E: count(rs, "E", (r) => r.hidden_pass !== null) },
    hiddenPass: { B: count(rs, "B", (r) => r.hidden_pass === true), E: count(rs, "E", (r) => r.hidden_pass === true) },
    suitePass: { B: count(rs, "B", (r) => r.suite_pass), E: count(rs, "E", (r) => r.suite_pass) },
    costUsd: { B: Number(cost(rs, "B").toFixed(4)), E: Number(cost(rs, "E").toFixed(4)) },
    detections: { D1: d.filter((x) => x.id === "D1").length, D3: d.filter((x) => x.id === "D3").length, D4: d.filter((x) => x.id === "D4").length },
  };
}

function setAll(span: ObsSpan, attrs: Record<string, string | number | boolean>): void {
  for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
}

async function emit(
  phase: "before" | "after",
  name: string,
  rs: Replay[],
  decision: { verdict: string; reasons: string[] },
  gateVersion: string,
): Promise<string | undefined> {
  const n = numbers(rs);
  let traceId: string | undefined;
  await withSpan("WORKFLOW", name, { repo: "rajkaria/roster", evidenceLevel: "B" }, async (root) => {
    traceId = root.traceId;
    setAll(root, {
      "roster.phase": phase,
      "roster.hidden_ran.B": n.hiddenRan.B,
      "roster.hidden_ran.E": n.hiddenRan.E,
      "roster.reemitted": true,
      "roster.hidden_pass.B": n.hiddenPass.B,
      "roster.hidden_pass.E": n.hiddenPass.E,
      "roster.gate.verdict": decision.verdict,
      "roster.detections.D1": n.detections.D1,
    });
    for (const r of rs) {
      await withSpan(
        "TOOL",
        `replay ${r.setup_id}`,
        { setup: r.setup_id, task: r.task_session_id, attempt: r.attempt, costUsd: r.cost_usd ?? undefined },
        async (s) =>
          setAll(s, {
            "roster.suite_pass": r.suite_pass,
            "roster.hidden_ran": r.hidden_pass !== null,
            "roster.hidden_pass": r.hidden_pass === true,
            "roster.scope_ok": r.scope_ok,
            "roster.replay_verdict": r.verdict,
          }),
      );
    }
    await withSpan("GUARDRAIL", "detections", { repo: "rajkaria/roster" }, async (s) =>
      setAll(s, {
        "roster.detections.D1": n.detections.D1,
        "roster.detections.D3": n.detections.D3,
        "roster.detections.D4": n.detections.D4,
      }),
    );
    await withSpan("GUARDRAIL", `gate ${gateVersion}`, { setup: "E", evidenceLevel: "B" }, async (s) =>
      setAll(s, {
        "roster.gate.version": gateVersion,
        "roster.gate.verdict": decision.verdict,
        "roster.gate.reasons": decision.reasons.join(" | "),
        "roster.hidden_ran.B": n.hiddenRan.B,
        "roster.hidden_ran.E": n.hiddenRan.E,
        "roster.hidden_pass.B": n.hiddenPass.B,
        "roster.hidden_pass.E": n.hiddenPass.E,
        "roster.cost_usd.B": n.costUsd.B,
        "roster.cost_usd.E": n.costUsd.E,
      }),
    );
  });
  return traceId;
}

const of = (id: string) => after.filter((r) => r.setup_id === id);
const afterDecision = gate(of("B") as never, of("E") as never, { budget: 12 });
if (afterDecision.verdict !== afterDecisionRecorded.verdict) {
  throw new Error(`v2 gate now says ${afterDecision.verdict}, recorded ${afterDecisionRecorded.verdict}`);
}

const live = await initObs({ workflowName: "roster-before-after" });
setSession(`before-after-${new Date().toISOString().slice(0, 16)}`);
const beforeTrace = await emit("before", "review-1 (before: v1 replay, v1 gate)", before, beforeDecision, "v1 (recorded)");
const afterTrace = await emit("after", "review-1b (after: v2 replay, v2 gate)", after, afterDecision, "v2");
await flushObs();
// Delivered means neither trace is left in the spool: the SDK sent it, or the immediate re-send did.
const delivered = (id: string | undefined) => id !== undefined && !existsSync(join(DEFAULT_SPOOL_DIR, `${id}.json`));

const result = {
  generatedAt: new Date().toISOString(),
  note: "Spans re-emitted from recorded results; span timings are emission times. Same 10 tests-track tasks, setups B and E.",
  exported: live && delivered(beforeTrace) && delivered(afterTrace),
  before: { traceId: beforeTrace ?? null, gate: "v1 (recorded)", verdict: beforeDecision.verdict, reasons: beforeDecision.reasons, ...numbers(before) },
  after: { traceId: afterTrace ?? null, gate: "v2", verdict: afterDecision.verdict, reasons: afterDecision.reasons, ...numbers(after) },
  sources: [
    ".roster/roster.db replays (plan review-1-p1)",
    "reports/self/review-1/decisions.json",
    "reports/self/review-1b/replays.json",
    "reports/self/review-1b/decision.json",
  ],
};
writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ before: result.before, after: result.after, exported: result.exported }, null, 1));
