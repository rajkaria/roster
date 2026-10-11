// Rules-file candidates (DESIGN.md §"Candidate generation").
//
//   const c = proposeRulesCandidate(baseRules, review.failure_codes);
//   c.rules;   // base text, unchanged, plus an appended "## Added by Roster" section
//   c.added;   // [{ rule, answers }] — every added rule cites the codes it answers
//
// The code-to-rule mapping lives in ./rules-lib.md, which is parsed at run time; this module holds no rule
// text of its own. Codes are deduplicated, keeping the order they were first seen in so the output is
// deterministic for a given input. A rule whose text already appears in the base (case-insensitive
// substring) is not added again. Codes the library does not map — F3 and F6 — add nothing.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FailureCode } from "../types.ts";

/** Heading of the section this module appends. */
export const ADDED_SECTION = "## Added by Roster";

const LIB_PATH = join(import.meta.dir, "rules-lib.md");
const KNOWN_CODES: ReadonlySet<string> = new Set(Object.values(FailureCode));
const ROW = /^\|\s*([A-Z][0-9]+)\s*\|\s*(\S.*?)\s*\|\s*$/;

export interface AddedRule {
  rule: string;
  answers: FailureCode[];
}

export interface RulesCandidate {
  rules: string;
  added: AddedRule[];
}

/**
 * Code-to-rule mapping, read from ./rules-lib.md. Rows whose code is not in the `FailureCode` enum are
 * ignored, so a typo in the table drops a rule rather than inventing a code.
 */
export function loadRulesLib(path: string = LIB_PATH): Map<FailureCode, string> {
  const lib = new Map<FailureCode, string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const row = ROW.exec(line);
    if (!row) continue;
    const code = row[1]!;
    if (!KNOWN_CODES.has(code)) continue;
    lib.set(code as FailureCode, row[2]!);
  }
  return lib;
}

/**
 * Base rules plus one appended rule per distinct failure code that the library maps. Returns the base text
 * untouched when nothing can be added.
 */
export function proposeRulesCandidate(baseRules: string, codes: FailureCode[]): RulesCandidate {
  const lib = loadRulesLib();
  const base = baseRules.toLowerCase();
  const seen = new Set<FailureCode>();
  const order: string[] = [];
  const answers = new Map<string, FailureCode[]>();

  for (const code of codes) {
    if (seen.has(code)) continue;
    seen.add(code);
    const rule = lib.get(code);
    if (rule === undefined || base.includes(rule.toLowerCase())) continue;
    const cited = answers.get(rule);
    if (cited) cited.push(code);
    else {
      answers.set(rule, [code]);
      order.push(rule);
    }
  }

  if (order.length === 0) return { rules: baseRules, added: [] };

  const bullets = order.map((rule) => `- ${rule} (answers ${answers.get(rule)!.join(", ")})`);
  const gap = baseRules === "" || baseRules.endsWith("\n\n") ? "" : baseRules.endsWith("\n") ? "\n" : "\n\n";
  return {
    rules: `${baseRules}${gap}${ADDED_SECTION}\n\n${bullets.join("\n")}\n`,
    added: order.map((rule) => ({ rule, answers: answers.get(rule)! })),
  };
}
