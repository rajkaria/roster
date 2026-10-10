// Opt-in smoke test: sends one 3-span trace (WORKFLOW → AGENT → TOOL) to neatlogs and prints its id.
// Needs NEATLOGS_API_KEY. Run: bun scripts/obs-smoke.ts
import { flushObs, initObs, setSession, withSpan } from "../src/obs/index.ts";

const enabled = await initObs({ workflowName: "roster-obs-smoke" });
if (!enabled) {
  console.error("neatlogs did not start (NEATLOGS_API_KEY is unset or init failed; see the warning above); nothing was sent.");
  process.exit(1);
}

const reviewId = `smoke-${Date.now()}`;
setSession(reviewId);

let traceId: string | undefined;
await withSpan("WORKFLOW", "review", { repo: "roster" }, async (root) => {
  traceId = root.traceId;
  await withSpan("AGENT", "coordinator", { setup: "smoke" }, async () => {
    await withSpan("TOOL", "ping", { task: "smoke-1", attempt: 1 }, async () => undefined);
  });
});

if (!(await flushObs())) {
  console.error(`review ${reviewId} was NOT confirmed sent: the SDK reported the export failed (see the warning above).`);
  process.exit(1);
}
console.log(`review ${reviewId} sent as one trace`);
console.log(`trace id: ${traceId ?? "(SDK did not expose a trace id)"}`);
console.log("trace url: not printed; neatlogs 1.1.28 exposes no trace URL, so find this trace id in the neatlogs dashboard");
