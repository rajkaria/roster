import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBackend, resolveSetup } from "../src/agent/backend.ts";
import { executeToolCall, initialState, TOOL_SPECS, type ToolContext } from "../src/agent/tools.ts";
import { fakeToolCall } from "../src/llm/client.ts";
import type { HarnessResult, HarnessRunOptions } from "../src/harness/types.ts";
import type { runClaude } from "../src/harness/claude.ts";
import { setupIdOf } from "../src/identity/index.ts";
import { reviewSlug } from "../src/review/export.ts";
import { loadSetups } from "../src/setups/registry.ts";
import type { Review } from "../src/types.ts";
import { makeFixture } from "./fixtures/make-fixture.ts";
import { createHash } from "node:crypto";

setDefaultTimeout(120_000);

const root = mkdtempSync(join(tmpdir(), "roster-backend-setups-"));
const repo = join(root, "repo");
const reportsDir = join(root, "reports");
const setupsRoot = join(root, "roster");
const SAMPLE = join(import.meta.dir, "fixtures", "samples", "claude-code-full.jsonl");
const RULES = "# Rules\n\n- Write tests for what you build.\n";
const OTHER_RULES = "# Rules\n\n- Be terse.\n";
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const def = (id: string, model: string, rules: string, extra: object = {}) =>
  JSON.stringify({ id, harness: "claude-code", model, rules, ...extra });

function writeSetups(): void {
  mkdirSync(join(setupsRoot, "setups", "rules"), { recursive: true });
  mkdirSync(join(setupsRoot, "setups", "candidates"), { recursive: true });
  writeFileSync(join(setupsRoot, "setups", "rules", "default.md"), RULES);
  writeFileSync(join(setupsRoot, "setups", "rules", "other.md"), OTHER_RULES);
  writeFileSync(join(setupsRoot, "setups", "A.json"), def("A", "claude-opus-5-5", "setups/rules/default.md"));
  writeFileSync(join(setupsRoot, "setups", "C.json"), def("C", "claude-opus-5-5", "setups/rules/other.md"));
  writeFileSync(
    join(setupsRoot, "setups", "candidates", "E.json"),
    def("E", "deepseek-flash", "setups/rules/default.md", { env: { ANTHROPIC_AUTH_TOKEN: "${TEST_TOKEN}" } }),
  );
  writeFileSync(
    join(setupsRoot, "setups", "candidates", "F.json"),
    def("F", "deepseek-flash", "setups/rules/other.md", { env: { ANTHROPIC_AUTH_TOKEN: "${TEST_TOKEN}" } }),
  );
}

const setups = () => loadSetups(setupsRoot, { TEST_TOKEN: "x" });
const review = (by_tag: Record<string, string[]>): Review =>
  ({ id: "r", repo: "o/n", tags: { by_tag: Object.fromEntries(Object.entries(by_tag).map(([k, v]) => [k, { sessions: 10, setup_ids: v }])), tag_accuracy: 1 } }) as unknown as Review;

describe("resolveSetup", () => {
  beforeAll(writeSetups);

  test("a definition id resolves to itself", () => {
    expect(resolveSetup("E", setups(), null).id).toBe("E");
  });

  test("a review id that the tags map to C resolves to setup C", () => {
    const r = review({ C: ["c8d6907735ec"], A: ["6a200cd990a7"] });
    expect(resolveSetup("c8d6907735ec", setups(), r).id).toBe("C");
  });

  test("the tag with the most sessions wins when an id is shared", () => {
    const r = review({ A: ["shared"], C: ["shared"] });
    r.tags!.by_tag.C!.sessions = 20;
    expect(resolveSetup("shared", setups(), r).id).toBe("C");
  });

  test("without tags, the same harness, model and rules hash matches", () => {
    const id = setupIdOf("claude-code", "claude-opus-5-5", sha(OTHER_RULES.trim()))!;
    expect(resolveSetup(id, setups(), null).id).toBe("C");
    expect(resolveSetup(id, setups(), review({ A: ["other"] })).id).toBe("C");
  });

  test("an unmatched id errors with the valid list", () => {
    expect(() => resolveSetup("deadbeef0000", setups(), null)).toThrow(/unknown setup deadbeef0000.*A, C, E, F/);
  });
});

describe("coordinator tools", () => {
  const ctx: ToolContext = { runId: "run-t50", repo, budgetUsd: 10, spentUsd: () => 0 };

  test("get_scorecard and plan_replays descriptions list candidates E and F", () => {
    for (const name of ["get_scorecard", "plan_replays"]) {
      const d = TOOL_SPECS.find((t) => t.name === name)!.description;
      expect(d).toMatch(/\bE\b.*\bF\b/);
      expect(d).toMatch(/setups\/candidates/);
    }
  });

  test("get_scorecard output names the candidates E and F", async () => {
    mkdirSync(join(reportsDir, reviewSlug(repo)), { recursive: true });
    writeFileSync(join(reportsDir, reviewSlug(repo), "review.json"), JSON.stringify({ id: "r", repo: "o/n", setups: [], suspect: null }));
    const b = defaultBackend({ reportsDir, replay: { repo, setupsRoot, env: { TEST_TOKEN: "x" } } });
    const out = JSON.parse((await executeToolCall(fakeToolCall("get_scorecard"), initialState(), ctx, b)).content);
    expect(out.ok).toBe(true);
    expect(out.result.candidates.map((c: { id: string }) => c.id)).toEqual(["E", "F"]);
  });

  test("a scripted run replays the incumbent (by review id) and E", async () => {
    makeFixture(repo, "basic");
    const stub: typeof runClaude = async (o: HarnessRunOptions): Promise<HarnessResult> => {
      mkdirSync(join(o.sandboxPath, "src"), { recursive: true });
      writeFileSync(join(o.sandboxPath, "src", `stub-${o.model}.ts`), "export {};\n");
      return {
        harness: "claude-code", sessionId: "stub", model: o.model, models: [], turns: 3, durationMs: 1, costUsd: 0.01,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, isError: false, errorKind: null, stopReason: "end_turn",
        transcriptPath: SAMPLE, diff: null, setupSha: null, attempts: [], command: [],
      };
    };
    writeFileSync(
      join(reportsDir, reviewSlug(repo), "review.json"),
      JSON.stringify(review({ A: ["6a200cd990a7"] })),
    );
    const b = defaultBackend({
      cacheDir: join(root, "cache"),
      reportsDir,
      replay: { repo, setupsRoot, env: { TEST_TOKEN: "x" }, workRoot: join(root, "work"), harness: stub, testCmd: "true" },
    });
    const task = (await b.listTasks!({ repo }))[0]!.id;
    const batch = await b.runReplays({ plan_id: "p", tasks: [task], setups: ["6a200cd990a7", "E"], max_cost_usd: 5 });
    expect(new Set(batch.replays.map((r) => r.setup_id))).toEqual(new Set(["A", "E"]));
    const rows = await b.getReplayResults({ plan_id: "p", setup: "6a200cd990a7" });
    expect(rows.every((r) => r.setup_id === "A")).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });
});
