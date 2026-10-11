// Generates llms.txt: a short map of the repo for a reviewer working with an AI assistant.
// Every line comes from a file in the repo (README.md, docs/DESIGN.md, docs/FACTS.md), so nothing here is invented.
import { readFileSync, writeFileSync } from "node:fs";

export type LlmsInput = {
  readme: string;
  designHeadings: string[];
  facts: string;
  repoUrl: string;
};

/** The README's first blockquote line, or undefined when the README has none. */
export function firstBlockquote(readme: string): string | undefined {
  for (const raw of readme.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith(">")) continue;
    const text = line.replace(/^>\s?/, "").trim();
    if (text !== "") return `> ${text}`;
  }
  return undefined;
}

/** Every ATX heading in a markdown document except the H1 title, in document order. */
export function extractDesignHeadings(markdown: string): string[] {
  const out: string[] = [];
  for (const raw of markdown.split(/\r?\n/)) {
    const m = raw.match(/^(#{2,6})\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    const text = (m[2] ?? "").trim();
    if (text !== "") out.push(text);
  }
  return out;
}

/** FACTS.md lines as written. The generated-file comment and its "# Facts" title are dropped; PENDING values are kept. */
export function factLines(facts: string): string[] {
  return facts
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("<!--") && t !== "# Facts";
    });
}

function githubBase(repoUrl: string): string {
  return repoUrl.trim().replace(/\/+$/, "").replace(/\.git$/, "");
}

export function renderLlms(input: LlmsInput): string {
  const base = githubBase(input.repoUrl);
  const out: string[] = ["# Roster", ""];

  const quote = firstBlockquote(input.readme);
  if (quote) out.push(quote, "");

  out.push(
    "## Docs",
    "",
    `- [docs/DESIGN.md](${base}/blob/main/docs/DESIGN.md) — the design contract`,
    `- [experiments/PREREGISTRATION.md](${base}/blob/main/experiments/PREREGISTRATION.md) — the frozen forward-run pre-registration`,
    `- [docs/FACTS.md](${base}/blob/main/docs/FACTS.md) — generated public numbers`,
    "",
    "## Design sections",
    "",
  );
  for (const h of input.designHeadings) {
    const text = h.replace(/^#+\s*/, "").replace(/\s*#+$/, "").trim();
    if (text !== "") out.push(`- ${text}`);
  }

  out.push("", "## Facts", "");
  out.push(...factLines(input.facts));

  return `${out.join("\n")}\n`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const repoUrl = flag("repo-url") ?? "https://github.com/rajkaria/roster";
  const design = readFileSync("docs/DESIGN.md", "utf8");
  const llms = renderLlms({
    readme: readFileSync("README.md", "utf8"),
    designHeadings: extractDesignHeadings(design),
    facts: readFileSync("docs/FACTS.md", "utf8"),
    repoUrl,
  });
  const out = flag("out");
  if (out) writeFileSync(out, llms);
  else process.stdout.write(llms);
}
