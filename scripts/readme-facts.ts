import { readFileSync, writeFileSync } from "node:fs";

const START = "<!-- facts:start -->";
const END = "<!-- facts:end -->";

function lookup(facts: string, key: string): string {
  for (const line of facts.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+) = (.*?)(?:\s+\(source:.*)?$/);
    if (!m || m[1] !== key) continue;
    const value = (m[2] ?? "").trim();
    return value === "" || value === "PENDING" ? "pending" : value;
  }
  return "pending";
}

export function renderResults(readme: string, facts: string, keys: string[]): string {
  const s = readme.indexOf(START);
  if (s < 0) return readme;
  const bodyStart = s + START.length;
  const e = readme.indexOf(END, bodyStart);
  if (e < 0) return readme;
  const bullets = keys.map((k) => `- ${k}: ${lookup(facts, k)}`).join("\n");
  return `${readme.slice(0, bodyStart)}\n${bullets}\n${readme.slice(e)}`;
}

if (import.meta.main) {
  const [readmePath = "README.md", factsPath = "docs/FACTS.md", ...keys] = process.argv.slice(2);
  const readme = readFileSync(readmePath, "utf8");
  writeFileSync(readmePath, renderResults(readme, readFileSync(factsPath, "utf8"), keys));
}
