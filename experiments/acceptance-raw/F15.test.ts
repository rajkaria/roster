import { describe, expect, test } from "bun:test";
import { loadForward } from "../../../web/lib/forward.ts";

describe("loadForward", () => {
  test("returns the summary wording verbatim", () => {
    const wording = "Forward run completed: 1 task";

    const result = loadForward({
      summary: { n: 1, wording },
      rows: [
        { task: "task-1", old: true, new: false, costOld: 12.5, costNew: 9.25 },
      ],
    });

    expect(result.summary?.wording).toBe(wording);
  });

  test("skips malformed rows and counts them in summary.skipped", () => {
    const result = loadForward({
      summary: { n: 2, wording: "Forward run completed: 2 tasks" },
      rows: [
        {
          task: "task-valid",
          old: false,
          new: true,
          costOld: null,
          costNew: 3.5,
        },
        // malformed: missing task
        { old: true, new: false, costOld: null, costNew: null },
        // malformed: costOld is not a number or null
        { task: "task-bad-cost", old: true, new: false, costOld: "free", costNew: null },
      ],
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].task).toBe("task-valid");
    expect(result.rows[0].old).toBe(false);
    expect(result.rows[0].new).toBe(true);
    expect(result.rows[0].costOld).toBeNull();
    expect(result.rows[0].costNew).toBe(3.5);
    expect(result.summary?.wording).toBe("Forward run completed: 2 tasks");
    expect((result.summary as unknown as { skipped?: number }).skipped).toBe(2);
  });
});
