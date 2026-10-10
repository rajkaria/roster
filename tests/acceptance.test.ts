import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeClient, type FakeStep } from "../src/llm/client.ts";
import {
  generateAcceptance,
  looksLikeImplementation,
  parseBacklog,
  type AcceptanceIndex,
} from "../src/forward/acceptance.ts";
import { acceptanceCommand, parseAcceptanceArgs } from "../src/cli/acceptance.ts";
import { UsageError } from "../src/cli/review.ts";

const BACKLOG = `# Forward backlog

## F01: Slugify
Turn a title into a URL slug: lowercase, spaces to dashes.
INTERFACE: src/util/slug.ts export function slugify(title: string): string

## F02: Clamp
Clamp a number between a min and a max.
INTERFACE: src/util/clamp.ts export const clamp = (n: number, lo: number, hi: number): number

## F03: Chunk
Split an array into chunks of a given size.
INTERFACE: src/util/chunk.ts export function chunk<T>(xs: T[], size: number): T[][]
`;

const testFor = (name: string, path: string) =>
  "```ts\n" +
  `import { test, expect } from "bun:test";\nimport { ${name} } from "../../../${path}";\n` +
  `test("${name} exists", () => { expect(typeof ${name}).toBe("function"); });\n` +
  "```";

const good = (n: number): FakeStep => ({
  content: [testFor("slugify", "src/util/slug.ts"), testFor("clamp", "src/util/clamp.ts"), testFor("chunk", "src/util/chunk.ts")][n],
  costUsd: 0.01,
  model: "deepseek-v4-pro",
});

let dir: string;
let out: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "roster-acc-"));
  out = join(dir, "acceptance");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("parseBacklog", () => {
  test("reads id, title, text and the INTERFACE line", () => {
    const tasks = parseBacklog(BACKLOG);
    expect(tasks.map((t) => t.id)).toEqual(["F01", "F02", "F03"]);
    expect(tasks[0]).toMatchObject({
      title: "Slugify",
      interfacePath: "src/util/slug.ts",
      interfaceName: "slugify",
    });
    expect(tasks[0]!.text).toContain("lowercase");
    expect(tasks[1]!.interfaceName).toBe("clamp");
  });

  test("a task without an INTERFACE line is an error", () => {
    expect(() => parseBacklog("## F01: x\nno interface here\n")).toThrow(/F01.*INTERFACE/);
  });
});

describe("looksLikeImplementation", () => {
  test("flags definitions of the interface name", () => {
    expect(looksLikeImplementation("export function slugify(s: string) { return s; }", "slugify")).toBe(true);
    expect(looksLikeImplementation("const slugify = (s: string) => s;", "slugify")).toBe(true);
    expect(looksLikeImplementation("export async function slugify() {}", "slugify")).toBe(true);
  });
  test("allows imports and calls", () => {
    expect(looksLikeImplementation('import { slugify } from "../x";\nexpect(slugify("A b")).toBe("a-b");', "slugify")).toBe(false);
  });
});

describe("generateAcceptance", () => {
  test("writes a file per task and an INDEX.json", async () => {
    const client = fakeClient([good(0), good(1), good(2)]);
    const res = await generateAcceptance({ backlog: BACKLOG, outDir: out, client, model: "deepseek-v4-pro", typesSource: "export type X = 1;" });
    expect(res.failed).toEqual([]);
    for (const id of ["F01", "F02", "F03"]) expect(existsSync(join(out, id, "acceptance.test.ts"))).toBe(true);
    const index = JSON.parse(readFileSync(join(out, "INDEX.json"), "utf8")) as AcceptanceIndex;
    expect(Object.keys(index.tasks)).toEqual(["F01", "F02", "F03"]);
    const f1 = index.tasks.F01!;
    expect(f1.model).toBe("deepseek-v4-pro");
    expect(f1.costUsd).toBe(0.01);
    expect(f1.sha256).toBe(new Bun.CryptoHasher("sha256").update(readFileSync(join(out, "F01", "acceptance.test.ts"))).digest("hex"));
  });

  test("the prompt carries the task text, the signature and types.ts, and nothing else of the repo", async () => {
    const client = fakeClient([good(0), good(1), good(2)]);
    await generateAcceptance({ backlog: BACKLOG, outDir: out, client, model: "m", typesSource: "export type MARKER = 1;" });
    const first = client.requests[0]!;
    expect(first.model).toBe("m");
    const prompt = first.messages.map((m) => m.content).join("\n");
    expect(prompt).toContain("lowercase");
    expect(prompt).toContain("export function slugify(title: string): string");
    expect(prompt).toContain("src/util/slug.ts");
    expect(prompt).toContain("MARKER");
    expect(prompt).not.toContain("Clamp a number");
  });

  test("a second run changes nothing and makes no model calls", async () => {
    const opts = { backlog: BACKLOG, outDir: out, model: "m", typesSource: "" };
    await generateAcceptance({ ...opts, client: fakeClient([good(0), good(1), good(2)]) });
    const before = [readFileSync(join(out, "INDEX.json"), "utf8"), readFileSync(join(out, "F02", "acceptance.test.ts"), "utf8")];
    const again = fakeClient([]);
    const res = await generateAcceptance({ ...opts, client: again });
    expect(again.requests).toHaveLength(0);
    expect(res.skipped).toEqual(["F01", "F02", "F03"]);
    expect([readFileSync(join(out, "INDEX.json"), "utf8"), readFileSync(join(out, "F02", "acceptance.test.ts"), "utf8")]).toEqual(before);
  });

  test("never overwrites an existing acceptance file", async () => {
    const f = join(out, "F01");
    Bun.spawnSync(["mkdir", "-p", f]);
    writeFileSync(join(f, "acceptance.test.ts"), "// hand written\n");
    const client = fakeClient([good(1), good(2)]);
    await generateAcceptance({ backlog: BACKLOG, outDir: out, client, model: "m", typesSource: "" });
    expect(readFileSync(join(f, "acceptance.test.ts"), "utf8")).toBe("// hand written\n");
    expect(client.requests).toHaveLength(2);
  });

  test("an output that implements the function is rejected and retried once", async () => {
    const bad: FakeStep = {
      content: "```ts\nexport function slugify(t: string) { return t.toLowerCase(); }\nimport { test } from 'bun:test';\n```",
      costUsd: 0.02,
    };
    const client = fakeClient([bad, good(0), good(1), good(2)]);
    const res = await generateAcceptance({ backlog: BACKLOG, outDir: out, client, model: "m", typesSource: "" });
    expect(client.requests).toHaveLength(4);
    expect(res.failed).toEqual([]);
    const body = readFileSync(join(out, "F01", "acceptance.test.ts"), "utf8");
    expect(body).not.toContain("export function slugify");
    const index = JSON.parse(readFileSync(join(out, "INDEX.json"), "utf8")) as AcceptanceIndex;
    expect(index.tasks.F01!.costUsd).toBeCloseTo(0.03);
    // the retry tells the model what was wrong
    expect(client.requests[1]!.messages.map((m) => m.content).join("\n")).toMatch(/implement/i);
  });

  test("two rejections leave no file and report the task as failed", async () => {
    const bad: FakeStep = { content: "function clamp(n: number) { return n; }" };
    const client = fakeClient([good(0), bad, bad, good(2)]);
    const res = await generateAcceptance({ backlog: BACKLOG, outDir: out, client, model: "m", typesSource: "" });
    expect(res.failed).toEqual(["F02"]);
    expect(existsSync(join(out, "F02", "acceptance.test.ts"))).toBe(false);
    const index = JSON.parse(readFileSync(join(out, "INDEX.json"), "utf8")) as AcceptanceIndex;
    expect(Object.keys(index.tasks)).toEqual(["F01", "F03"]);
  });
});

describe("roster acceptance CLI", () => {
  test("parses args", () => {
    expect(parseAcceptanceArgs(["--backlog", "b.md", "--out", "o/"])).toEqual({ backlog: "b.md", out: "o/" });
    expect(parseAcceptanceArgs(["--backlog=b.md"]).out).toBe("experiments/acceptance/");
    expect(() => parseAcceptanceArgs([])).toThrow(UsageError);
    expect(() => parseAcceptanceArgs(["--backlog", "b.md", "--nope"])).toThrow(UsageError);
  });

  test("is a Command named acceptance", () => {
    expect(acceptanceCommand.name).toBe("acceptance");
  });
});
