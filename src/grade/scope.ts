import { FailureCode } from "../types.ts";

export interface Violation {
  code: FailureCode;
  path: string;
  detail: string;
}

/**
 * F1 when a pre-existing test file is deleted or changed other than by appending
 * (new cases may be appended; existing text must be a prefix of the new text).
 */
export function testEditViolations(
  preexisting: string[],
  base: (path: string) => string | null,
  patched: (path: string) => string | null,
): Violation[] {
  const out: Violation[] = [];
  for (const path of preexisting) {
    const before = base(path);
    if (before === null) continue;
    const after = patched(path);
    if (after === null) out.push({ code: FailureCode.F1, path, detail: "pre-existing test file deleted" });
    else if (!after.startsWith(before)) out.push({ code: FailureCode.F1, path, detail: "pre-existing test cases modified" });
  }
  return out;
}

/** F7 for each changed file that is not under one of the touched directories ("." or "" = anywhere). */
export function offScopeViolations(changed: string[], touchedDirs: string[]): Violation[] {
  const dirs = touchedDirs.map((d) => d.replace(/^\.\/|\/+$/g, ""));
  if (dirs.some((d) => d === "" || d === ".")) return [];
  return changed
    .filter((p) => !dirs.some((d) => p === d || p.startsWith(`${d}/`)))
    .map((path) => ({ code: FailureCode.F7, path, detail: "edit outside touched directories" }));
}
