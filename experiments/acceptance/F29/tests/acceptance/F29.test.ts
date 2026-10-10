import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportRun } from "../../src/report/export.ts";

describe("exportRun", () => {
  let outDir = "";

  async function readJson(fileName: string): Promise<Record<string, unknown>> {
    const raw = await readFile(path.join(outDir, fileName), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  }

  beforeEach(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), "f29-export-"));
  });

  afterEach(async () => {
    if (outDir) await rm(outDir, { recursive: true, force: true });
  });

  test("always writes review.json with schemaVersion, generatedAt, and data", async () => {
    const review = { id: "r1", repo: "owner/repo" };

    const paths = await exportRun({ review }, outDir);

    expect(paths).toEqual([path.join(outDir, "review.json")]);
    const content = await readJson("review.json");
    expect(Object.keys(content).sort()).toEqual(["data", "generatedAt", "schemaVersion"]);
    expect(content.schemaVersion).toBe(1);
    expect(content.generatedAt).toBeDefined();
    expect(content.data).toEqual(review);
    expect((await readdir(outDir)).sort()).toEqual(["review.json"]);
  });

  test("writes plan.json, replays.json, and gate.json when present", async () => {
    const review = { id: "r1" };
    const plan = { suspect: "s1", tasks: ["t1"], candidates: [], budget_usd: 100 };
    const replays = [{ id: "replay-1", verdict: "pass" }];
    const gate = [{ id: "gate-1", verdict: "promote" }];

    const paths = await exportRun({ review, plan, replays, gate }, outDir);

    expect(paths).toEqual([
      path.join(outDir, "gate.json"),
      path.join(outDir, "plan.json"),
      path.join(outDir, "replays.json"),
      path.join(outDir, "review.json"),
    ]);

    const reviewContent = await readJson("review.json");
    const planContent = await readJson("plan.json");
    const replaysContent = await readJson("replays.json");
    const gateContent = await readJson("gate.json");

    expect(reviewContent.data).toEqual(review);
    expect(planContent.data).toEqual(plan);
    expect(replaysContent.data).toEqual(replays);
    expect(gateContent.data).toEqual(gate);

    for (const content of [reviewContent, planContent, replaysContent, gateContent]) {
      expect(content.schemaVersion).toBe(1);
      expect(content.generatedAt).toBeDefined();
    }

    expect((await readdir(outDir)).sort()).toEqual(["gate.json", "plan.json", "replays.json", "review.json"]);
  });

  test("writes optional files when present even if their values are empty", async () => {
    const paths = await exportRun({ review: {}, plan: {}, replays: [], gate: [] }, outDir);

    expect(paths).toEqual([
      path.join(outDir, "gate.json"),
      path.join(outDir, "plan.json"),
      path.join(outDir, "replays.json"),
      path.join(outDir, "review.json"),
    ]);
  });

  test("omits optional files when they are not present", async () => {
    const paths = await exportRun({ review: { id: "r1" } }, outDir);

    expect(paths).toEqual([path.join(outDir, "review.json")]);
    expect((await readdir(outDir)).sort()).toEqual(["review.json"]);
  });

  test("leaves no temporary files after writing", async () => {
    await exportRun({ review: { id: "r1" }, plan: { id: "p1" } }, outDir);

    expect((await readdir(outDir)).sort()).toEqual(["plan.json", "review.json"]);
  });

  test("re-export overwrites and only generatedAt can change for identical data", async () => {
    const review = { id: "r1", repo: "owner/repo" };

    const firstPaths = await exportRun({ review }, outDir);
    const first = await readJson("review.json");

    const secondPaths = await exportRun({ review }, outDir);
    const second = await readJson("review.json");

    expect(secondPaths).toEqual(firstPaths);

    const firstRecord = first as Record<string, unknown>;
    const secondRecord = second as Record<string, unknown>;
    expect(Object.keys(secondRecord).sort()).toEqual(Object.keys(firstRecord).sort());
    for (const key of Object.keys(secondRecord)) {
      if (key !== "generatedAt") {
        expect(secondRecord[key]).toEqual(firstRecord[key]);
      }
    }

    const changedReview = { id: "r2", repo: "another/repo" };
    await exportRun({ review: changedReview }, outDir);
    const third = await readJson("review.json");

    expect(third.data).toEqual(changedReview);
    expect((await readdir(outDir)).sort()).toEqual(["review.json"]);
  });
});
