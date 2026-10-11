// Runs detections D1–D4 over review 1b's saved replays and writes reports/self/review-1b/detections.json.
import { readFileSync, writeFileSync } from "node:fs";
import { detectionsFor } from "../../src/agent/coordinator.ts";

const dir = "reports/self/review-1b";
const replays = JSON.parse(readFileSync(`${dir}/replays.json`, "utf8"));
const incumbent = process.argv[2] ?? "B";
const detections = detectionsFor(replays, incumbent);
writeFileSync(`${dir}/detections.json`, JSON.stringify(detections, null, 2) + "\n");
console.log(`${detections.length} detection(s) over ${replays.length} replays (incumbent ${incumbent}) -> ${dir}/detections.json`);
for (const d of detections) console.log(`  ${d.id} ${d.setup ?? "-"} ${d.task ?? "-"}: ${d.detail}`);
