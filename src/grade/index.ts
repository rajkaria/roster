import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitEnv, runGit } from "../sandbox/index.ts";
import type { Sandbox } from "../sandbox/index.ts";
import { offScopeViolations, testEditViolations } from "./scope.ts";
import type { Violation } from "./scope.ts";
import { isTestFile } from "./hidden.ts";
import type { HiddenTest } from "./hidden.ts";

export { hiddenTests, isTestFile } from "./hidden.ts";
export type { HiddenTest } from "./hidden.ts";
export type { Violation } from "./scope.ts";

export interface PerTest {
  file: string;
  name: string;
  pass: boolean;
}

export interface GradeResult {
  hiddenPass: boolean;
  /** null when the full suite was not run (phase "fast"). */
  suitePass: boolean | null;
  /**
   * When the suite failed: the test files still failing after the retry, or null when the run left no JUnit (killed,
   * timed out or crashed). Undefined when the suite passed or did not run.
   */
  suiteFailing?: string[] | null;
  /** null when no typecheck ran. */
  typecheckPass?: boolean | null;
  /** The change's own new test files (fast phase); null when it added none. */
  ownPass?: boolean | null;
  scopeOk: boolean;
  violations: Violation[];
  perTest: PerTest[];
}

export interface GradeInput {
  /** The agent's workspace. Read only: grading happens in a fresh copy. */
  sandbox: Sandbox;
  hidden: HiddenTest[];
  /** Override for the auto-detected test command. */
  testCmd?: string;
  /** Repo-relative paths of test files that existed at base. */
  preexistingTests: string[];
  /** Directories the original change touched; when omitted the off-scope check is skipped. */
  touchedDirs?: string[];
  timeoutMs?: number;
  /**
   * "all" (default): full suite, then hidden tests. "fast": hidden tests, the change's own new test files and the
   * typecheck, no full suite. "suite": the full suite only.
   */
  phase?: "all" | "fast" | "suite";
  /** Where node_modules (and web/node_modules) are symlinked from into the grading copy; default: the sandbox. */
  modulesFrom?: string;
  /** Shell runner, injectable for tests. */
  runner?: StepRunner;
}

export type StepKind = "suite" | "retry" | "hidden" | "own" | "typecheck";
/** Runs one grading step; may be async (the default is, so grading never blocks the event loop). */
export type StepRunner = (cwd: string, cmd: string, timeoutMs: number, kind: StepKind) => boolean | Promise<boolean>;

/** Test command by project markers: bun, pnpm, npm, pytest, go test. */
export function detectTestCmd(dir: string): string {
  const has = (f: string) => existsSync(join(dir, f));
  if (has("bun.lock") || has("bun.lockb") || has("bunfig.toml")) return "bun test";
  if (has("pnpm-lock.yaml")) return "pnpm test";
  if (has("package.json")) return "npm test";
  if (has("pyproject.toml") || has("pytest.ini") || has("setup.py")) return "pytest";
  if (has("go.mod")) return "go test ./...";
  throw new Error(`cannot detect a test command in ${dir}; pass testCmd`);
}

const unescape = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? unescape(m[1]!) : undefined;
}

interface JunitCase {
  file: string;
  name: string;
  failed: boolean;
  skipped: boolean;
}

function junitCases(xml: string): JunitCase[] {
  const out: JunitCase[] = [];
  const stack: string[] = [];
  const tokens = xml.match(/<testsuite\b[^>]*>|<\/testsuite>|<testcase\b[^>]*?\/>|<testcase\b[^>]*>[\s\S]*?<\/testcase>/g) ?? [];
  for (const t of tokens) {
    if (t.startsWith("</testsuite")) stack.pop();
    else if (t.startsWith("<testsuite")) stack.push(attr(t, "file") ?? attr(t, "name") ?? stack.at(-1) ?? "");
    else {
      const head = t.slice(0, t.indexOf(">") + 1);
      const file = attr(head, "file") ?? stack.find((s) => /\.[a-z]+$/.test(s)) ?? stack[0] ?? "";
      out.push({ file, name: attr(head, "name") ?? "", failed: /<(failure|error)\b/.test(t), skipped: /<skipped\b/.test(t) });
    }
  }
  return out;
}

/** Per-testcase results from a JUnit file, attributed to the test file of the enclosing suite. */
export function parseJunit(xml: string): PerTest[] {
  return junitCases(xml).map((c) => ({ file: c.file, name: c.name, pass: !c.failed && !c.skipped }));
}

/** Test files with at least one failed or errored case (skips don't count), in first-seen order. */
export function failingTestFiles(xml: string): string[] {
  return [...new Set(junitCases(xml).filter((c) => c.failed).map((c) => c.file.replace(/^\.\//, "")))].filter(Boolean);
}

// Async on purpose: a spawnSync here froze the whole forward run (every worker, every agent launch) for the length of
// each suite run, so "parallel" pairs were graded one step at a time.
const sh: StepRunner = async (cwd, cmd, timeoutMs) => {
  const p = Bun.spawn(["bash", "-c", cmd], { cwd, env: gitEnv(), stdout: "ignore", stderr: "ignore", timeout: timeoutMs });
  return (await p.exited) === 0;
};

function hasTypecheck(dir: string): boolean {
  try {
    return typeof JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts?.typecheck === "string";
  } catch {
    return false;
  }
}

function showOrNull(cwd: string, rev: string, path: string): string | null {
  const r = Bun.spawnSync(["git", "show", `${rev}:${path}`], { cwd });
  return r.exitCode === 0 ? r.stdout.toString() : null;
}

// macOS tar packs extended attributes and AppleDouble files by default; a file whose xattrs vanish mid-read makes the
// producer fail, and without pipefail the half-written copy went unnoticed (missing .git objects, "bad object" later).
const TAR_FLAGS = process.platform === "darwin" ? "--no-xattrs --no-mac-metadata " : "";
const COPY_CMD = `set -o pipefail; tar ${TAR_FLAGS}-C "$1" --exclude=./node_modules --exclude=./web/node_modules -cf - . | tar ${TAR_FLAGS}-C "$2" -xf -`;

/** Copies `from` into the empty directory `to` (without node_modules), retrying once from scratch. */
export function copyTree(from: string, to: string): void {
  let err = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    rmSync(to, { recursive: true, force: true });
    mkdirSync(to, { recursive: true });
    const cp = Bun.spawnSync(["bash", "-c", COPY_CMD, "bash", from, to], { env: { ...gitEnv(), COPYFILE_DISABLE: "1" } });
    if (cp.exitCode === 0) return;
    err = cp.stderr.toString().trim();
  }
  throw new Error(`copy failed: ${err}`);
}

/** A suite with more failing files than this failed for real, not on timing: no retry. */
const SUITE_RETRY_MAX_FILES = 5;

/** Grade a finished replay in a fresh copy: base + the agent's patch (+ hidden tests for the second run). */
export async function grade(input: GradeInput): Promise<GradeResult> {
  const { sandbox, hidden, preexistingTests } = input;
  const timeout = input.timeoutMs ?? 300_000;
  const phase = input.phase ?? "all";
  const run = input.runner ?? sh;
  const root = mkdtempSync(join(tmpdir(), "roster-grade-"));
  const work = join(root, "work");
  const out = join(root, "junit"); // JUnit lives outside the workspace
  mkdirSync(out);
  try {
    // node_modules is the bulk of the copy and is cleaned out below anyway: leave it behind and link it back in.
    copyTree(sandbox.path, work);

    // Capture the agent's change as a patch, then rebuild the tree from base + patch.
    runGit(work, ["add", "-A"]);
    const patch = runGit(work, ["diff", "--cached", "--binary", sandbox.baseSha]);
    const changed = runGit(work, ["diff", "--cached", "--name-only", "-z", sandbox.baseSha]).split("\0").filter(Boolean);
    const patchedText = (p: string) => showOrNull(work, ":0", p);
    const violations: Violation[] = [
      ...testEditViolations(preexistingTests, (p) => showOrNull(work, sandbox.baseSha, p), patchedText),
      ...(input.touchedDirs ? offScopeViolations(changed, input.touchedDirs) : []),
    ];
    runGit(work, ["reset", "-q", "--hard", sandbox.baseSha]);
    runGit(work, ["clean", "-qfdx"]);
    if (patch) {
      const pf = join(out, "agent.patch");
      writeFileSync(pf, patch + "\n");
      runGit(work, ["apply", "--binary", pf]);
    }

    const modulesFrom = input.modulesFrom ?? sandbox.path;
    for (const rel of ["node_modules", "web/node_modules"]) {
      const src = join(modulesFrom, rel);
      if (!existsSync(src)) continue;
      mkdirSync(dirname(join(work, rel)), { recursive: true });
      symlinkSync(src, join(work, rel), "dir");
    }

    const testCmd = input.testCmd ?? detectTestCmd(work);
    const isBun = /^bun test\b/.test(testCmd);
    const junit = (name: string) => (isBun ? ` --reporter=junit --reporter-outfile=${join(out, name)}` : "");
    const scopeOk = violations.length === 0;

    let suitePass: boolean | null = null;
    let suiteFailing: string[] | null | undefined;
    if (phase !== "fast") {
      suitePass = await run(work, testCmd + junit("suite.xml"), timeout, "suite");
      // A loaded machine fails the odd test on timing: re-run only the failing files, once. A run that left no JUnit
      // (killed, crashed, import errors bun drops) has nothing to retry and stays failed.
      const xml = join(out, "suite.xml");
      const retryXml = join(out, "suite-retry.xml");
      if (!suitePass && isBun && existsSync(xml)) {
        const failing = failingTestFiles(readFileSync(xml, "utf8"));
        suiteFailing = failing;
        if (failing.length > 0 && failing.length <= SUITE_RETRY_MAX_FILES) {
          suitePass = await run(work, `${testCmd} ${failing.map((f) => JSON.stringify(f)).join(" ")}${junit("suite-retry.xml")}`, timeout, "retry");
          if (!suitePass) suiteFailing = existsSync(retryXml) ? failingTestFiles(readFileSync(retryXml, "utf8")) : null;
        }
      } else if (!suitePass) suiteFailing = null;
      if (suitePass) suiteFailing = undefined;
    }
    if (phase === "suite") return { hiddenPass: true, suitePass, suiteFailing, typecheckPass: null, scopeOk, violations, perTest: [] };

    const fileArgs = isBun || /^pytest\b/.test(testCmd);
    // In the fast phase the change's own new test files run separately from the hidden ones.
    const own =phase === "fast" && fileArgs ? changed.filter((p) => isTestFile(p) && !preexistingTests.includes(p) && !hidden.some((h) => h.path === p) && existsSync(join(work, p))) : [];
    for (const h of hidden) {
      mkdirSync(dirname(join(work, h.path)), { recursive: true });
      writeFileSync(join(work, h.path), h.content);
    }
    const files = hidden.map((h) => JSON.stringify(h.path)).join(" ");
    const skipRun = phase === "fast" && fileArgs && files === "";
    const runPass = skipRun || (await run(work, `${testCmd}${fileArgs ? " " + files : ""}${junit("hidden.xml")}`, timeout, "hidden"));
    const ownPass: boolean | null = own.length ? await run(work, `${testCmd} ${own.map((p) => JSON.stringify(p)).join(" ")}${junit("own.xml")}`, timeout, "own") : null;

    let typecheckPass: boolean | null = null;
    if (phase === "fast" && isBun && hasTypecheck(work)) typecheckPass = await run(work, "bun run typecheck", timeout, "typecheck");

    let perTest: PerTest[] = [];
    let hiddenPass = runPass;
    const xmlPath = join(out, "hidden.xml");
    if (isBun) {
      const all = existsSync(xmlPath) ? parseJunit(readFileSync(xmlPath, "utf8")) : [];
      const norm = (f: string) => f.replace(/^\.\//, "");
      for (const h of hidden) {
        const cases = all.filter((t) => norm(t.file).endsWith(h.path) || h.path.endsWith(norm(t.file)));
        if (cases.length === 0) {
          // bun's JUnit reporter drops files that fail to import: count it as a failure.
          perTest.push({ file: h.path, name: "(collected 0 tests)", pass: false });
        } else perTest.push(...cases.map((c) => ({ ...c, file: h.path })));
      }
      hiddenPass = runPass && perTest.every((t) => t.pass);
    } else if (hidden.length === 0) hiddenPass = true;

    return { hiddenPass, suitePass, suiteFailing, typecheckPass, ownPass, scopeOk, violations, perTest };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
