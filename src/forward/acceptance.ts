// The acceptance-test writer (DESIGN.md §"Forward run"): one bun:test file per backlog task, written from the task
// text and the exported signatures alone, before any setup runs the task. Frozen once written.
//
// Backlog format: each task is a `## <Fxx>: <title>` block. Its body is the task text, plus one line
// `INTERFACE: <path> <signature>`, e.g. `INTERFACE: src/util/slug.ts export function slugify(t: string): string`.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage, LlmClient } from "../llm/client.ts";

export const DEFAULT_ACCEPTANCE_MODEL = "deepseek-v4-pro";
export const ACCEPTANCE_FILE = "acceptance.test.ts";

/** The model the writer uses: env ROSTER_ACCEPTANCE_MODEL, else deepseek-v4-pro. */
export function acceptanceModel(): string {
  return process.env.ROSTER_ACCEPTANCE_MODEL || DEFAULT_ACCEPTANCE_MODEL;
}

export interface BacklogTask {
  id: string;
  title: string;
  /** The task text without the INTERFACE line. */
  text: string;
  interfacePath: string;
  /** The signature as written after the path. */
  interfaceSignature: string;
  /** The identifier the signature declares. */
  interfaceName: string;
}

export interface IndexEntry {
  model: string;
  costUsd: number | null;
  sha256: string;
}

export interface AcceptanceIndex {
  tasks: Record<string, IndexEntry>;
}

const DECLARES = /\b(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

/** Splits a backlog into task blocks. Throws on a block with no usable INTERFACE line. */
export function parseBacklog(md: string): BacklogTask[] {
  const tasks: BacklogTask[] = [];
  const blocks = md.split(/^## +/m).slice(1);
  for (const block of blocks) {
    const [head = "", ...rest] = block.split("\n");
    const m = /^(\S+?)\s*[:—-]\s*(.*)$/.exec(head.trim());
    const id = m?.[1] ?? head.trim().split(/\s+/)[0] ?? "";
    const title = m?.[2] ?? "";
    const body = rest.join("\n");
    const line = /^INTERFACE:[ \t]*(\S+)[ \t]+(.+)$/m.exec(body);
    const name = line ? DECLARES.exec(line[2]!)?.[1] : undefined;
    if (!line || !name) throw new Error(`backlog task ${id}: missing or unreadable INTERFACE line (INTERFACE: <path> <signature>)`);
    tasks.push({
      id,
      title,
      text: body.replace(line[0], "").trim(),
      interfacePath: line[1]!,
      interfaceSignature: line[2]!.trim(),
      interfaceName: name,
    });
  }
  return tasks;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Heuristic: true when the code defines something called `name` (function, const arrow/value, class). */
export function looksLikeImplementation(code: string, name: string): boolean {
  const n = escapeRe(name);
  return new RegExp(`\\b(?:function\\*?|const|let|var|class)\\s+${n}\\b`).test(code);
}

/** The first fenced code block of a reply, else the reply itself. */
export function extractCode(reply: string): string {
  const m = /```[\w-]*\n([\s\S]*?)```/.exec(reply);
  return (m ? m[1]! : reply).trim() + "\n";
}

const SYSTEM = `You write acceptance tests for a coding task you have not seen implemented.
You get the task text, the interface to test, and the repo's shared types. Return exactly one bun:test file in one \`\`\`ts block.
Rules:
- Import the interface from its stated path, relative to the test file's location (experiments/acceptance/<id>/acceptance.test.ts).
- Test behaviour the task text states. Do not assume anything it does not say.
- Never define or implement the interface yourself, not even as a stub or helper with its name.`;

function userPrompt(t: BacklogTask, typesSource: string): string {
  return [
    `Task ${t.id}: ${t.title}`,
    t.text,
    `Interface (import it from "${t.interfacePath}"):`,
    t.interfaceSignature,
    `Current exported types (src/types.ts):`,
    "```ts\n" + typesSource.trimEnd() + "\n```",
  ].join("\n\n");
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface GenerateOptions {
  backlog: string;
  outDir: string;
  client: LlmClient;
  model: string;
  /** Contents of src/types.ts. */
  typesSource: string;
}

export interface GenerateResult {
  written: string[];
  skipped: string[];
  failed: string[];
}

/** Writes acceptance files for tasks that have none. Existing files are never touched. */
export async function generateAcceptance(opts: GenerateOptions): Promise<GenerateResult> {
  const tasks = parseBacklog(opts.backlog);
  const indexPath = join(opts.outDir, "INDEX.json");
  const index: AcceptanceIndex = existsSync(indexPath)
    ? (JSON.parse(readFileSync(indexPath, "utf8")) as AcceptanceIndex)
    : { tasks: {} };
  const before = JSON.stringify(index, null, 2);
  const result: GenerateResult = { written: [], skipped: [], failed: [] };

  for (const t of tasks) {
    const file = join(opts.outDir, t.id, ACCEPTANCE_FILE);
    if (existsSync(file)) {
      // Frozen. Record it only if the index has never seen it.
      index.tasks[t.id] ??= { model: "unknown", costUsd: null, sha256: sha256(readFileSync(file, "utf8")) };
      result.skipped.push(t.id);
      continue;
    }
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM },
      { role: "user", content: userPrompt(t, opts.typesSource) },
    ];
    let cost: number | null = 0;
    let model = opts.model;
    let code: string | null = null;
    for (let attempt = 1; attempt <= 2 && code === null; attempt++) {
      const res = await opts.client.chat({ messages, model: opts.model });
      cost = cost === null || res.costUsd === null ? null : cost + res.costUsd;
      model = res.model;
      const candidate = extractCode(res.message.content ?? "");
      if (!looksLikeImplementation(candidate, t.interfaceName)) code = candidate;
      else {
        messages.push(
          { role: "assistant", content: res.message.content ?? "" },
          {
            role: "user",
            content: `Rejected: your file defines \`${t.interfaceName}\`, which implements the interface. Return a test file that only imports it from "${t.interfacePath}".`,
          },
        );
      }
    }
    if (code === null) {
      result.failed.push(t.id);
      continue;
    }
    mkdirSync(join(opts.outDir, t.id), { recursive: true });
    writeFileSync(file, code, { flag: "wx" });
    index.tasks[t.id] = { model, costUsd: cost, sha256: sha256(code) };
    result.written.push(t.id);
  }

  // Keep the index in backlog order; rewrite only on change.
  const ordered: AcceptanceIndex = { tasks: {} };
  for (const t of tasks) if (index.tasks[t.id]) ordered.tasks[t.id] = index.tasks[t.id]!;
  for (const [k, v] of Object.entries(index.tasks)) ordered.tasks[k] ??= v;
  const after = JSON.stringify(ordered, null, 2);
  if (after !== before || !existsSync(indexPath)) {
    mkdirSync(opts.outDir, { recursive: true });
    writeFileSync(indexPath, after + "\n");
  }
  return result;
}
