import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportRun, SCHEMA_VERSION } from "../src/report/export.ts";

const tmpRoot = () => mkdtemp(path.join(tmpdir(), "f29-report-export-"));

describe("exportRun", () => {
  let root = "";
  let outDir = "";

  beforeEach(async () => {
    root = await tmpRoot();
    outDir = path.join(root, "out");
    await mkdir(outDir);
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function readJson(fileName: string): Promise<Record<string, unknown>> {
    const raw = await readFile(path.join(outDir, fileName), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  }

  const names = async () => (await readdir(outDir)).sort();

  test("always writes review.json as { schemaVersion, generatedAt, data }", async () => {
    const review = { id: "r1", repo: "owner/repo", label: "suspect" };

    const paths = await exportRun({ review }, outDir);

    expect(paths).toEqual([path.join(outDir, "review.json")]);
    const content = await readJson("review.json");
    expect(Object.keys(content).sort()).toEqual(["data", "generatedAt", "schemaVersion"]);
    expect(content.schemaVersion).toBe(SCHEMA_VERSION);
    expect(content.data).toEqual(review);
    expect(await names()).toEqual(["review.json"]);
  });

  test("writes plan.json, replays.json and gate.json when the run carries them", async () => {
    const review = { id: "r1" };
    const plan = { tasks: ["t1"], candidates: ["c1"] };
    const replays = [{ id: "rp1", verdict: "pass" }, { id: "rp2", verdict: "fail" }];
    const gate = [{ id: "g1", verdict: "promote", reasons: ["forward win"] }];

    const paths = await exportRun({ review, plan, replays, gate }, outDir);

    expect(paths).toEqual([
      path.join(outDir, "gate.json"),
      path.join(outDir, "plan.json"),
      path.join(outDir, "replays.json"),
      path.join(outDir, "review.json"),
    ]);
    expect((await readJson("plan.json")).data).toEqual(plan);
    expect((await readJson("replays.json")).data).toEqual(replays);
    expect((await readJson("gate.json")).data).toEqual(gate);
    expect(await names()).toEqual(["gate.json", "plan.json", "replays.json", "review.json"]);
  });

  test("writes an optional file even when its value is empty", async () => {
    const paths = await exportRun({ review: {}, plan: {}, replays: [], gate: [] }, outDir);

    expect(paths).toEqual([
      path.join(outDir, "gate.json"),
      path.join(outDir, "plan.json"),
      path.join(outDir, "replays.json"),
      path.join(outDir, "review.json"),
    ]);
    expect((await readJson("plan.json")).data).toEqual({});
    expect((await readJson("replays.json")).data).toEqual([]);
    expect((await readJson("gate.json")).data).toEqual([]);
  });

  test("omits optional files that are absent, explicitly undefined included", async () => {
    const paths = await exportRun({ review: { id: "r1" }, plan: undefined, replays: undefined, gate: undefined }, outDir);

    expect(paths).toEqual([path.join(outDir, "review.json")]);
    expect(await names()).toEqual(["review.json"]);
  });

  test("returns the written paths sorted", async () => {
    const paths = await exportRun({ review: {}, replays: [] }, outDir);

    expect(paths).toEqual([...paths].sort());
  });

  test("generatedAt is a current ISO-8601 timestamp, shared by one run's files", async () => {
    const before = Date.now();
    await exportRun({ review: {}, plan: {} }, outDir);
    const after = Date.now();

    const review = await readJson("review.json");
    const plan = await readJson("plan.json");
    expect(typeof review.generatedAt).toBe("string");
    const at = Date.parse(review.generatedAt as string);
    expect(Number.isNaN(at)).toBe(false);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
    expect(plan.generatedAt).toBe(review.generatedAt);
  });

  test("creates outDir when it does not exist", async () => {
    const missing = path.join(root, "nested", "reports");

    const paths = await exportRun({ review: { id: "r1" } }, missing);

    expect(paths).toEqual([path.join(missing, "review.json")]);
    expect(await readdir(missing)).toEqual(["review.json"]);
  });

  test("leaves no temp files after writing", async () => {
    await exportRun({ review: { id: "r1" }, plan: {}, replays: [], gate: [] }, outDir);

    expect(await names()).toEqual(["gate.json", "plan.json", "replays.json", "review.json"]);
  });

  test("re-export overwrites, and only generatedAt can differ for identical data", async () => {
    const review = { id: "r1", repo: "owner/repo" };

    const firstPaths = await exportRun({ review, plan: { id: "p1" } }, outDir);
    const first = await readJson("review.json");

    const secondPaths = await exportRun({ review, plan: { id: "p1" } }, outDir);
    const second = await readJson("review.json");

    expect(secondPaths).toEqual(firstPaths);
    expect(Object.keys(second).sort()).toEqual(Object.keys(first).sort());
    for (const key of Object.keys(second)) {
      if (key !== "generatedAt") expect(second[key]).toEqual(first[key]);
    }
    expect(await names()).toEqual(["plan.json", "review.json"]);
  });

  test("re-export replaces the data of every section", async () => {
    await exportRun({ review: { id: "r1" }, plan: { budget_usd: 100 } }, outDir);
    await exportRun({ review: { id: "r2" }, plan: { budget_usd: 50 } }, outDir);

    expect((await readJson("review.json")).data).toEqual({ id: "r2" });
    expect((await readJson("plan.json")).data).toEqual({ budget_usd: 50 });
  });

  test("failure to serialize writes nothing, not even the sections already built", async () => {
    const review = { id: "r1" };

    await expect(exportRun({ review, plan: { big: 1n } }, outDir)).rejects.toThrow();
    expect(await names()).toEqual([]);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(exportRun({ review, plan: circular }, outDir)).rejects.toThrow();
    expect(await names()).toEqual([]);
  });

  test("throws when the run has no review, and writes nothing", async () => {
    await expect(exportRun({ review: undefined } as { review: unknown }, outDir)).rejects.toThrow(/review/);
    expect(await names()).toEqual([]);
  });

  test("leaves unrelated files in outDir untouched", async () => {
    await writeFile(path.join(outDir, "sessions.json"), "{}\n");
    await exportRun({ review: { id: "r1" } }, outDir);

    expect(await names()).toEqual(["review.json", "sessions.json"]);
    expect(await readFile(path.join(outDir, "sessions.json"), "utf8")).toBe("{}\n");
  });

  test("does not delete a report file a later run does not ask for", async () => {
    await exportRun({ review: { id: "r1" }, plan: { id: "p1" } }, outDir);
    await exportRun({ review: { id: "r1" } }, outDir);

    expect(await names()).toEqual(["plan.json", "review.json"]);
  });
});
