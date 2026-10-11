// Exports one roster run to versioned JSON report files. See docs/DESIGN.md §"Data model".
// Every file is written as { schemaVersion, generatedAt, data }, so a reader can tell which shape it
// is looking at without guessing from the contents. Writes are atomic: a temp file next to the target
// is renamed over it, so a reader never sees a half-written report and no temp file survives a run.
import { access, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

/** Version of the `{ schemaVersion, generatedAt, data }` envelope written by exportRun. */
export const SCHEMA_VERSION = 1;

/** A run as the coordinator holds it: a review, plus the plan, replays and gate decisions when there are any. */
export interface RunExport {
  review: unknown;
  plan?: unknown;
  replays?: unknown[];
  gate?: unknown[];
}

/** The envelope every report file shares. */
export interface ReportFile {
  schemaVersion: number;
  generatedAt: string;
  data: unknown;
}

/** One section of a run: the file it becomes, the RunExport key it reads, and whether it is optional. */
const SECTIONS = [
  { fileName: "review.json", key: "review", optional: false },
  { fileName: "plan.json", key: "plan", optional: true },
  { fileName: "replays.json", key: "replays", optional: true },
  { fileName: "gate.json", key: "gate", optional: true },
] as const satisfies readonly { fileName: string; key: keyof RunExport; optional: boolean }[];

/**
 * Writes review.json always, and plan.json, replays.json and gate.json when the run carries them
 * (an optional section is absent only when it is undefined; an empty object or array still gets a
 * file). Each file holds `{ schemaVersion: 1, generatedAt, data }`. `outDir` is created when missing.
 * Returns the written paths, sorted.
 *
 * Re-export overwrites the files it writes; with identical data, generatedAt is the only field that
 * changes. Files the run does not ask for are left untouched, so an export never deletes unrelated
 * content of `outDir`.
 */
export async function exportRun(run: RunExport, outDir: string): Promise<string[]> {
  if (run === null || typeof run !== "object") throw new Error("exportRun: run must be an object");
  if (run.review === undefined) throw new Error("exportRun: run.review is required; review.json is always written");

  // Every section is serialized before the first write, so data that cannot be encoded as JSON (a
  // circular reference, a BigInt, a throwing toJSON) fails the export without leaving any file behind.
  const generatedAt = new Date().toISOString();
  const files = SECTIONS.filter((s) => !s.optional || run[s.key] !== undefined).map((s) => ({
    fileName: s.fileName,
    body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, generatedAt, data: run[s.key] } satisfies ReportFile, null, 2) + "\n",
  }));

  await mkdir(outDir, { recursive: true });

  const paths: string[] = [];
  for (const { fileName, body } of files) {
    const path = join(outDir, fileName);
    await writeAtomic(path, body);
    paths.push(path);
  }
  return paths.sort();
}

/** Writes `body` to a unique temp file next to `path`, then renames it over `path`. */
async function writeAtomic(path: string, body: string): Promise<void> {
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, body);
    await rename(tmp, path);
  } catch (err) {
    // The rename either happened (and the temp file is gone) or it did not; only remove a temp file we own.
    if (await exists(tmp)) await unlink(tmp).catch(() => {});
    throw err;
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
