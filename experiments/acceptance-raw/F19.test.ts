import { describe, expect, test } from "bun:test";
import { runCorpus } from "../../../scripts/corpus-run.ts";

describe("runCorpus", () => {
  test("selects top candidates by score with repo-name tie-break and writes success reports and final index", async () => {
    const candidates = [
      { repo: "c/repo", score: 5 },
      { repo: "a/repo", score: 4 },
      { repo: "b/repo", score: 5 },
      { repo: "d/repo", score: 1 },
    ];

    const reviewCalls: string[] = [];
    const writes: { path: string; data: unknown }[] = [];

    const review = async (repo: string): Promise<unknown> => {
      reviewCalls.push(repo);
      return { repo, status: "reviewed" };
    };

    const write = async (path: string, data: unknown): Promise<void> => {
      writes.push({ path, data });
    };

    const result = await runCorpus({ candidates, top: 2, review, write });

    expect(reviewCalls).toEqual(["b/repo", "c/repo"]);

    expect(writes).toHaveLength(3);
    expect(writes[0]).toEqual({
      path: "reports/corpus/b__repo/review.json",
      data: { repo: "b/repo", status: "reviewed" },
    });
    expect(writes[1]).toEqual({
      path: "reports/corpus/c__repo/review.json",
      data: { repo: "c/repo", status: "reviewed" },
    });
    expect(writes[2]).toEqual({
      path: "reports/corpus/index.json",
      data: { done: ["b/repo", "c/repo"], failed: [] },
    });

    expect(result).toEqual({ done: ["b/repo", "c/repo"], failed: [] });
  });

  test("records a throwing review and continues the run", async () => {
    const candidates = [
      { repo: "a/repo", score: 10 },
      { repo: "bad/repo", score: 9 },
      { repo: "b/repo", score: 8 },
    ];

    const reviewCalls: string[] = [];
    const writes: { path: string; data: unknown }[] = [];

    const review = async (repo: string): Promise<unknown> => {
      reviewCalls.push(repo);
      if (repo === "bad/repo") {
        throw new Error("boom");
      }
      return { repo, status: "reviewed" };
    };

    const write = async (path: string, data: unknown): Promise<void> => {
      writes.push({ path, data });
    };

    const result = await runCorpus({ candidates, top: 3, review, write });

    expect(reviewCalls).toEqual(["a/repo", "bad/repo", "b/repo"]);

    expect(writes.map((w) => w.path)).toEqual([
      "reports/corpus/a__repo/review.json",
      "reports/corpus/b__repo/review.json",
      "reports/corpus/index.json",
    ]);

    expect(writes[0]).toEqual({
      path: "reports/corpus/a__repo/review.json",
      data: { repo: "a/repo", status: "reviewed" },
    });
    expect(writes[1]).toEqual({
      path: "reports/corpus/b__repo/review.json",
      data: { repo: "b/repo", status: "reviewed" },
    });
    expect(writes[2]).toEqual({
      path: "reports/corpus/index.json",
      data: {
        done: ["a/repo", "b/repo"],
        failed: [{ repo: "bad/repo", reason: "boom" }],
      },
    });

    expect(result).toEqual({
      done: ["a/repo", "b/repo"],
      failed: [{ repo: "bad/repo", reason: "boom" }],
    });
  });
});
