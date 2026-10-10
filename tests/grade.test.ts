import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { grade, detectTestCmd, hiddenTests } from "../src/grade/index.ts";
import { createSandbox, destroySandbox, runGit } from "../src/sandbox/index.ts";
import { FailureCode } from "../src/types.ts";

const ADD_TEST = `import { expect, test } from "bun:test";
import { add } from "../src/add.ts";
test("add", () => { expect(add(1, 2)).toBe(3); });
`;
const MUL_TEST = `import { expect, test } from "bun:test";
import { mul } from "../src/mul.ts";
test("mul", () => { expect(mul(2, 3)).toBe(6); });
`;
const MUL_SRC = "export const mul = (a: number, b: number) => a * b;\n";

let tmp: string;
let repo: string;
let baseSha: string;
let originalSha: string;
let roots = 0;

function put(root: string, rel: string, content: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}
function commit(msg: string) {
  runGit(repo, ["add", "-A"]);
  runGit(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", msg]);
  return runGit(repo, ["rev-parse", "HEAD"]);
}
async function sandbox(edit: (path: string) => void) {
  const sb = await createSandbox(repo, baseSha, { root: join(tmp, `sb${roots++}`) });
  edit(sb.path);
  return sb;
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "roster-grade-test-"));
  repo = join(tmp, "repo");
  mkdirSync(repo);
  runGit(repo, ["init", "-q", "-b", "main"]);
  put(repo, "package.json", '{"name":"fx"}\n');
  put(repo, "bun.lock", "");
  put(repo, "src/add.ts", "export const add = (a: number, b: number) => a + b;\n");
  put(repo, "tests/add.test.ts", ADD_TEST);
  baseSha = commit("base");
  put(repo, "src/mul.ts", MUL_SRC);
  put(repo, "tests/mul.test.ts", MUL_TEST);
  originalSha = commit("original change");
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const hidden = () => hiddenTests(repo, originalSha);

describe("hiddenTests", () => {
  test("returns test files from the original change, taken at HEAD when young", () => {
    const h = hidden();
    expect(h.map((t) => t.path)).toEqual(["tests/mul.test.ts"]);
    expect(h[0]!.content).toBe(MUL_TEST);
  });

  test("keeps the version from when the change landed, not later edits", () => {
    const fixed = MUL_TEST.replace("toBe(6)", "toBe(6); // matured");
    put(repo, "tests/mul.test.ts", fixed);
    commit("c1");
    for (let i = 2; i <= 5; i++) {
      put(repo, "notes.txt", `n${i}\n`);
      commit(`c${i}`);
    }
    // The later edit (c1) and the commits after it do not change what the session added.
    expect(hidden()[0]!.content).toBe(MUL_TEST);
    expect(hidden()[0]!.content).not.toBe(fixed);
  });
});

describe("detectTestCmd", () => {
  test("detects bun from the lockfile", () => {
    expect(detectTestCmd(repo)).toBe("bun test");
  });
});

describe("grade", () => {
  const run = (sb: { path: string; baseSha: string }, extra = {}) =>
    grade({
      sandbox: sb,
      hidden: [{ path: "tests/mul.test.ts", content: MUL_TEST }],
      testCmd: "bun test",
      preexistingTests: ["tests/add.test.ts"],
      touchedDirs: ["src", "tests"],
      ...extra,
    });

  test("a correct replay passes everything", async () => {
    const sb = await sandbox((p) => put(p, "src/mul.ts", MUL_SRC));
    const g = await run(sb);
    expect(g).toMatchObject({ hiddenPass: true, suitePass: true, scopeOk: true, violations: [] });
    expect(g.perTest.some((t) => t.name.includes("mul") && t.pass)).toBe(true);
    await destroySandbox(sb.path);
  });

  test("does not touch the agent's workspace", async () => {
    const sb = await sandbox((p) => put(p, "src/mul.ts", MUL_SRC));
    await run(sb);
    const r = Bun.spawnSync(["ls", join(sb.path, "tests")]);
    expect(r.stdout.toString()).not.toContain("mul.test.ts");
  });

  test("editing an existing test is scopeOk=false with F1", async () => {
    const sb = await sandbox((p) => {
      put(p, "src/mul.ts", MUL_SRC);
      put(p, "tests/add.test.ts", ADD_TEST.replace("toBe(3)", "toBeDefined()"));
    });
    const g = await run(sb);
    expect(g.scopeOk).toBe(false);
    expect(g.violations.map((v) => v.code)).toContain(FailureCode.F1);
  });

  test("appending a case to an existing test is allowed", async () => {
    const sb = await sandbox((p) => {
      put(p, "src/mul.ts", MUL_SRC);
      put(p, "tests/add.test.ts", ADD_TEST + 'test("add2", () => { expect(1).toBe(1); });\n');
    });
    expect((await run(sb)).scopeOk).toBe(true);
  });

  test("breaking the suite is suitePass=false", async () => {
    const sb = await sandbox((p) => {
      put(p, "src/mul.ts", MUL_SRC);
      put(p, "src/add.ts", "export const add = (a: number, b: number) => a - b;\n");
    });
    const g = await run(sb);
    expect(g.suitePass).toBe(false);
  });

  test("edits outside the touched directories are F7", async () => {
    const sb = await sandbox((p) => {
      put(p, "src/mul.ts", MUL_SRC);
      put(p, "deploy/secret.sh", "echo hi\n");
    });
    const g = await run(sb);
    expect(g.scopeOk).toBe(false);
    expect(g.violations.map((v) => v.code)).toContain(FailureCode.F7);
  });

  test("a hidden file that collects 0 tests is a failing case", async () => {
    const sb = await sandbox((p) => put(p, "src/mul.ts", MUL_SRC));
    const g = await run(sb, {
      hidden: [{ path: "tests/broken.test.ts", content: 'import "../src/does-not-exist.ts";\n' }],
    });
    expect(g.hiddenPass).toBe(false);
    expect(g.perTest.some((t) => t.file === "tests/broken.test.ts" && !t.pass)).toBe(true);
  });

  test("hidden tests fail when the feature is missing", async () => {
    const sb = await sandbox(() => {});
    const g = await run(sb);
    expect(g.hiddenPass).toBe(false);
    expect(g.suitePass).toBe(true);
  });
});
