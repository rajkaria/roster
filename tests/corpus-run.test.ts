import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { INDEX_PATH, rankCorpus, reviewPath, runCorpus, type CorpusCandidate } from "../scripts/corpus-run";

// Recorded by scripts/corpus-find.ts (reports/corpus/candidates.json): real repo names and scores.
const recorded: CorpusCandidate[] = JSON.parse(
  readFileSync(new URL("../reports/corpus/candidates.json", import.meta.url), "utf8"),
).map((c: CorpusCandidate) => ({ repo: c.repo, score: c.score }));

const recorder = () => {
  const calls: string[] = [];
  const writes: { path: string; data: unknown }[] = [];
  return {
    calls,
    writes,
    review: async (repo: string) => (calls.push(repo), { repo, status: "reviewed" }),
    write: async (path: string, data: unknown) => void writes.push({ path, data }),
  };
};

describe("rankCorpus (recorded candidates)", () => {
  test("ranks by score descending, ties by repo name", () => {
    expect(rankCorpus(recorded, 3).map((c) => c.repo)).toEqual([
      "teslamint/entirecontext",
      "gkeyllorg/postgkyl",
      "crcorbett/taxkit", // 400, tied with yorrick/agent-skills
    ]);
    expect(recorded.some((c) => c.repo === "yorrick/agent-skills" && c.score === 400)).toBe(true);
  });

  test("does not mutate the caller's list, and clamps top", () => {
    const input = [...recorded];
    expect(rankCorpus(input, 0)).toEqual([]);
    expect(rankCorpus(recorded, recorded.length + 5)).toHaveLength(recorded.length);
    expect(input).toEqual(recorded);
  });
});

describe("reviewPath", () => {
  test("owner/name becomes owner__name", () => {
    expect(reviewPath("b/repo")).toBe("reports/corpus/b__repo/review.json");
    expect(reviewPath("teslamint/entirecontext")).toBe("reports/corpus/teslamint__entirecontext/review.json");
  });
});

describe("runCorpus", () => {
  test("reviews the top candidates sequentially and writes the index last", async () => {
    const r = recorder();
    const result = await runCorpus({
      candidates: recorded,
      top: 2,
      review: r.review,
      write: r.write,
    });

    expect(r.calls).toEqual(["teslamint/entirecontext", "gkeyllorg/postgkyl"]);
    expect(r.writes.map((w) => w.path)).toEqual([
      "reports/corpus/teslamint__entirecontext/review.json",
      "reports/corpus/gkeyllorg__postgkyl/review.json",
      INDEX_PATH,
    ]);
    expect(r.writes[0]?.data).toEqual({ repo: "teslamint/entirecontext", status: "reviewed" });
    expect(r.writes[2]?.data).toEqual({ done: r.calls, failed: [] });
    expect(result).toEqual({ done: ["teslamint/entirecontext", "gkeyllorg/postgkyl"], failed: [] });
  });

  test("a throwing review is recorded with its message and the run keeps going", async () => {
    const writes: { path: string; data: unknown }[] = [];
    const calls: string[] = [];
    const review = async (repo: string): Promise<unknown> => {
      calls.push(repo);
      if (repo === "gkeyllorg/postgkyl") throw new Error("clone timed out");
      return { repo, status: "reviewed" };
    };

    const result = await runCorpus({
      candidates: recorded,
      top: 3,
      review,
      write: async (path, data) => void writes.push({ path, data }),
    });

    expect(calls).toEqual(["teslamint/entirecontext", "gkeyllorg/postgkyl", "crcorbett/taxkit"]);
    // No review.json for the repo that failed, and the index carries both lists.
    expect(writes.map((w) => w.path)).toEqual([
      "reports/corpus/teslamint__entirecontext/review.json",
      "reports/corpus/crcorbett__taxkit/review.json",
      INDEX_PATH,
    ]);
    expect(result).toEqual({
      done: ["teslamint/entirecontext", "crcorbett/taxkit"],
      failed: [{ repo: "gkeyllorg/postgkyl", reason: "clone timed out" }],
    });
    expect(writes[2]?.data).toEqual(result);
  });

  test("a non-Error throw is stringified, and an all-failed run still writes the index", async () => {
    const r = recorder();
    const result = await runCorpus({
      candidates: recorded.slice(0, 2),
      top: 2,
      review: async () => {
        throw "no sandbox";
      },
      write: r.write,
    });

    expect(r.writes).toHaveLength(1);
    expect(r.writes[0]?.path).toBe(INDEX_PATH);
    expect(r.writes[0]?.data).toEqual(result);
    expect(result.done).toEqual([]);
    expect(result.failed).toEqual([
      { repo: "teslamint/entirecontext", reason: "no sandbox" },
      { repo: "gkeyllorg/postgkyl", reason: "no sandbox" },
    ]);
  });
});
