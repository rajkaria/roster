// Review 1b: re-run review 1's exact replay plan (same 12 tasks; incumbent B vs candidate E) with the v2 replay
// (hidden tests arrive with their support files) and the v2 gate (a 0–0 tie is "no signal" and promotes nothing).
// Before/after evidence for the README and the neatlogs comparison. Writes reports/self/review-1b/.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { buildReplayTasks } from "../../src/replay/tasks.ts";
import { loadSetups } from "../../src/setups/registry.ts";
import { runReplays } from "../../src/replay/run.ts";
import { gate } from "../../src/gate/index.ts";
import { initObs, withSpan, setSession, flushObs } from "../../src/obs/index.ts";

const repo = process.cwd();
const out = "reports/self/review-1b";
const j = (p: string) => { const v = JSON.parse(readFileSync(p, "utf8")); return Array.isArray(v) ? v : v.sessions ?? v.outcomes ?? v.data; };
const plan = JSON.parse(readFileSync("reports/self/review-1/plan.json", "utf8"));
const all = buildReplayTasks(repo, j("reports/rajkaria__roster/sessions.json"), j("reports/rajkaria__roster/outcomes.json"));
// Only tasks with hidden tests carry a pass/fail signal; review 1's two judge-only tasks are left out (they "passed" for every setup).
const tasks = all.filter((t) => (plan.tasks.includes(t.sessionId ?? t.id) || plan.tasks.includes(t.id)) && t.track === "tests");
const setups = loadSetups(repo, process.env).filter((s) => ["B", "E"].includes(s.id));
console.log(`review-1b: ${tasks.length} of ${plan.tasks.length} planned tasks found; setups ${setups.map((s) => s.id).join(",")}`);

await initObs({ workflowName: "roster-review-1b" });
setSession("review-1b");
const result = await withSpan("WORKFLOW", "review-1b", { repo: "rajkaria/roster", evidenceLevel: "B" }, async () => {
  // One task at a time, saved after each, so a stop loses at most one task and a rerun skips what's done.
  mkdirSync(out, { recursive: true });
  const partial = `${out}/replays.partial.json`;
  const replays: any[] = (() => { try { return JSON.parse(readFileSync(partial, "utf8")); } catch { return []; } })();
  for (const t of tasks) {
    if (replays.some((r) => r.task_session_id === t.id)) continue;
    const rs = await runReplays({ repo, tasks: [t], setups, workRoot: "/Users/Shared/roster-replays", parallel: 1, maxCostUsd: 12, planId: "review-1b" });
    replays.push(...rs);
    writeFileSync(partial, JSON.stringify(replays, null, 2));
    console.log(`review-1b: ${t.id} done (${replays.length / setups.length} of ${tasks.length})`);
  }
  const of = (id: string) => replays.filter((r) => r.setup_id === id);
  const decision = await withSpan("GUARDRAIL", "gate", { setup: "E" }, async () => gate(of("B"), of("E"), { budget: 12 }));
  return { replays, decision };
});
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/replays.json`, JSON.stringify(result.replays, null, 2));
writeFileSync(`${out}/decision.json`, JSON.stringify(result.decision, null, 2));
console.log(JSON.stringify({ verdict: result.decision.verdict, hidden_pass: result.decision.hidden_pass, cost: result.decision.cost, reasons: result.decision.reasons }));
await flushObs();
