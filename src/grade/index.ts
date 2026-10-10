import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitEnv, runGit } from "../sandbox/index.ts";
import type { Sandbox } from "../sandbox/index.ts";
import { offScopeViolations, testEditViolations } from "./scope.ts";
import type { Violation } from "./scope.ts";
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
  suitePass: boolean;
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
}

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

/** Per-testcase results from a JUnit file, attributed to the test file of the enclosing suite. */
export function parseJunit(xml: string): PerTest[] {
  const out: PerTest[] = [];
  const stack: string[] = [];
  const tokens = xml.match(/<testsuite\b[^>]*>|<\/testsuite>|<testcase\b[^>]*?\/>|<testcase\b[^>]*>[\s\S]*?<\/testcase>/g) ?? [];
  for (const t of tokens) {
    if (t.startsWith("</testsuite")) stack.pop();
    else if (t.startsWith("<testsuite")) stack.push(attr(t, "file") ?? attr(t, "name") ?? stack.at(-1) ?? "");
    else {
      const head = t.slice(0, t.indexOf(">") + 1);
      const file = attr(head, "file") ?? stack.find((s) => /\.[a-z]+$/.test(s)) ?? stack[0] ?? "";
      const bad = /<(failure|error)\b/.test(t) || /<skipped\b/.test(t);
      out.push({ file, name: attr(head, "name") ?? "", pass: !bad });
    }
  }
  return out;
}

function sh(cwd: string, cmd: string, timeoutMs: number) {
  const r = Bun.spawnSync(["bash", "-c", cmd], { cwd, env: gitEnv(), timeout: timeoutMs });
  return r.exitCode === 0;
}

function showOrNull(cwd: string, rev: string, path: string): string | null {
  const r = Bun.spawnSync(["git", "show", `${rev}:${path}`], { cwd });
  return r.exitCode === 0 ? r.stdout.toString() : null;
}

/** Grade a finished replay in a fresh copy: base + the agent's patch (+ hidden tests for the second run). */
export async function grade(input: GradeInput): Promise<GradeResult> {
  const { sandbox, hidden, preexistingTests } = input;
  const timeout = input.timeoutMs ?? 300_000;
  const root = mkdtempSync(join(tmpdir(), "roster-grade-"));
  const work = join(root, "work");
  const out = join(root, "junit"); // JUnit lives outside the workspace
  mkdirSync(out);
  try {
    const cp = Bun.spawnSync(["cp", "-R", sandbox.path, work]);
    if (cp.exitCode !== 0) throw new Error(`copy failed: ${cp.stderr.toString().trim()}`);

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

    const testCmd = input.testCmd ?? detectTestCmd(work);
    const isBun = /^bun test\b/.test(testCmd);
    const junit = (name: string) => (isBun ? ` --reporter=junit --reporter-outfile=${join(out, name)}` : "");

    const suitePass = sh(work, testCmd + junit("suite.xml"), timeout);

    for (const h of hidden) {
      mkdirSync(dirname(join(work, h.path)), { recursive: true });
      writeFileSync(join(work, h.path), h.content);
    }
    const files = hidden.map((h) => JSON.stringify(h.path)).join(" ");
    const runPass = sh(work, `${testCmd}${isBun || /^pytest\b/.test(testCmd) ? " " + files : ""}${junit("hidden.xml")}`, timeout);

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

    return { hiddenPass, suitePass, scopeOk: violations.length === 0, violations, perTest };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
