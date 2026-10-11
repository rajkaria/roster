// F15: the experiment page's data helper.
// Fixture rows use the published shape checked in with this task's acceptance test
// (experiments/acceptance/F15/tests/acceptance/F15.test.ts), which is the real sample of what loadForward reads.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadForward, loadForwardFile, loadPrereg, loadPreregFile } from "../web/lib/forward.ts";

const ROOT = join(import.meta.dir, "..");

const pair = (task: string, old: boolean, new_: boolean, costOld: number | null, costNew: number | null) => ({
  task,
  old,
  new: new_,
  costOld,
  costNew,
});

describe("loadForward", () => {
  test("returns the summary wording verbatim and the parsed pairs", () => {
    const wording = "Forward run completed: 1 task";
    const result = loadForward({
      summary: { n: 1, wording },
      rows: [{ task: "task-1", old: true, new: false, costOld: 12.5, costNew: 9.25 }],
    });

    expect(result.summary?.wording).toBe(wording);
    expect(result.summary?.n).toBe(1);
    expect(result.summary?.skipped).toBe(0);
    expect(result.rows).toEqual([
      { task: "task-1", old: true, new: false, costOld: 12.5, costNew: 9.25 },
    ]);
  });

  test("skips malformed rows and counts them in summary.skipped", () => {
    const result = loadForward({
      summary: { n: 2, wording: "Forward run completed: 2 tasks" },
      rows: [
        pair("task-valid", false, true, null, 3.5),
        // missing task
        { old: true, new: false, costOld: null, costNew: null },
        // costOld is not a number or null
        { task: "task-bad-cost", old: true, new: false, costOld: "free", costNew: null },
      ],
    });

    expect(result.rows.map((r) => r.task)).toEqual(["task-valid"]);
    expect(result.summary?.skipped).toBe(2);
  });

  test("every malformed shape is dropped, never given a default", () => {
    const result = loadForward({
      rows: [
        null,
        "task-not-an-object",
        [],
        // no pass flags
        { task: "no-pass-flags", costOld: null, costNew: null },
        // pass flags are not booleans
        { task: "string-pass", old: "yes", new: true, costOld: null, costNew: null },
        // empty task id
        { task: "", old: true, new: false, costOld: null, costNew: null },
        // cost is not finite
        { task: "infinite-cost", old: true, new: false, costOld: null, costNew: Infinity },
        // excluded must be a string when present
        { task: "bad-excluded", old: true, new: false, costOld: null, costNew: null, excluded: 3 },
        pair("keeper", false, false, 1, 2),
      ],
    });

    expect(result.rows.map((r) => r.task)).toEqual(["keeper"]);
    expect(result.summary).toBeNull();
  });

  test("an unpriced task keeps null costs and lands in the table", () => {
    const [r] = loadForward({ rows: [{ task: "unpriced", old: true, new: true }] }).rows;
    expect(r).toEqual({ task: "unpriced", old: true, new: true, costOld: null, costNew: null });
  });

  test("an excluded task keeps its written reason", () => {
    const rows = loadForward({
      rows: [{ task: "invalidated", old: false, new: false, costOld: null, costNew: null, excluded: "architecture change" }],
    }).rows;
    expect(rows[0]?.excluded).toBe("architecture change");
  });

  test("a file with no summary still yields its rows", () => {
    const result = loadForward({ rows: [pair("task-1", true, false, null, null)] });
    expect(result.rows).toHaveLength(1);
    expect(result.summary).toBeNull();
  });

  test("a summary missing n or wording is rejected, not half-read", () => {
    expect(loadForward({ summary: { wording: "no count" }, rows: [] }).summary).toBeNull();
    expect(loadForward({ summary: { n: 3 }, rows: [] }).summary).toBeNull();
    expect(loadForward({ summary: "not an object", rows: [] }).summary).toBeNull();
  });

  test("json that is not an object gives no rows and no summary", () => {
    for (const bad of [null, undefined, 7, "text", [], true]) {
      expect(loadForward(bad)).toEqual({ rows: [], summary: null });
    }
  });

  test("a missing rows array is an empty run, not a crash", () => {
    expect(loadForward({ summary: { n: 0, wording: "Forward run completed: 0 tasks" } }).rows).toEqual([]);
  });
});

describe("loadForwardFile", () => {
  function withDataDir(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), "roster-forward-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("null while the forward run has not started", () => {
    withDataDir((dir) => expect(loadForwardFile(dir)).toBeNull());
  });

  test("reads self/forward.json under the data dir", () => {
    withDataDir((dir) => {
      mkdirSync(join(dir, "self"));
      writeFileSync(
        join(dir, "self", "forward.json"),
        JSON.stringify({
          summary: { n: 1, wording: "Forward run completed: 1 task" },
          rows: [pair("task-1", true, false, 1.5, null)],
        }),
      );
      const result = loadForwardFile(dir);
      expect(result?.rows).toHaveLength(1);
      expect(result?.summary?.wording).toBe("Forward run completed: 1 task");
    });
  });

  test("a corrupt file is treated as absent, not as a crash", () => {
    withDataDir((dir) => {
      mkdirSync(join(dir, "self"));
      writeFileSync(join(dir, "self", "forward.json"), "{not json");
      expect(loadForwardFile(dir)).toBeNull();
    });
  });
});

describe("loadPrereg", () => {
  const hash = "ac682b239225a99f45ffb347e1e73aa6fe1aec3159abb0ea928ffa6ffc3c63c7";

  test("finds the frozen backlog hash under a recognised key", () => {
    expect(loadPrereg({ backlog_sha256: hash })).toBe(hash);
    expect(loadPrereg({ backlogSha256: hash })).toBe(hash);
    expect(loadPrereg({ sha256: hash })).toBe(hash);
    expect(loadPrereg({ backlog: { sha256: hash } })).toBe(hash);
  });

  test("normalises the hash and ignores anything that is not 64 hex", () => {
    expect(loadPrereg({ backlog_sha256: hash.toUpperCase() })).toBe(hash);
    expect(loadPrereg({ backlog_sha256: "not a hash" })).toBeNull();
    expect(loadPrereg({ backlog_sha256: hash.slice(0, 63) })).toBeNull();
    expect(loadPrereg({ acceptance_sha256: hash })).toBeNull();
    expect(loadPrereg({ backlog_sha256: 12 })).toBeNull();
  });

  test("no hash anywhere gives null", () => {
    for (const bad of [null, undefined, "text", 3, {}, []]) expect(loadPrereg(bad)).toBeNull();
  });
});

describe("loadPreregFile", () => {
  test("reads self/prereg.json when present, null when absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-prereg-"));
    try {
      expect(loadPreregFile(dir)).toBeNull();
      mkdirSync(join(dir, "self"));
      writeFileSync(join(dir, "self", "prereg.json"), JSON.stringify({ backlog_sha256: "ab".repeat(32) }));
      expect(loadPreregFile(dir)).toBe("ab".repeat(32));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("page source", () => {
  const page = readFileSync(join(ROOT, "web", "app", "experiment", "page.tsx"), "utf8");

  test("shows the empty state and the pre-registration link", () => {
    expect(page).toContain("The forward run has not started");
    expect(page).toContain("/blob/main/experiments/PREREGISTRATION.md");
  });

  test("shows the published wording verbatim, with no rewrite", () => {
    expect(page).toContain("{summary.wording}");
  });

  test("no em dashes", () => {
    expect(page).not.toContain("—");
  });
});
