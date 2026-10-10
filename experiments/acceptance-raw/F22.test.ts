import { describe, expect, test } from "bun:test";
import { renderStatus } from "../../../src/cli/status.ts";

type StatusEvent = Parameters<typeof renderStatus>[0][number];

describe("renderStatus", () => {
  test("returns no runs yet when there are no events", () => {
    expect(renderStatus([], 100).trim()).toBe("no runs yet");
  });

  test("renders latest run status: last completed step, in-progress step, failed step, and cost vs budget", () => {
    const events: StatusEvent[] = [
      { runId: "old", step: "legacy", status: "done", at: "2024-01-01T00:00:00Z", costUsd: 10 },
      { runId: "latest", step: "plan", status: "done", at: "2024-01-02T00:00:00Z" },
      { runId: "latest", step: "edit", status: "started", at: "2024-01-02T00:01:00Z" },
      { runId: "latest", step: "test", status: "failed", at: "2024-01-02T00:02:00Z" },
      { runId: "latest", step: "report", status: "done", at: "2024-01-02T00:03:00Z", costUsd: 0.6 },
    ];

    const output = renderStatus(events, 5);

    expect(output).toContain("report");
    expect(output.toLowerCase()).toContain("in progress");
    expect(output).toContain("edit");
    expect(output.toLowerCase()).toContain("failed");
    expect(output).toContain("test");
    expect(output).toContain("$0.60 of $5.00");
    expect(output).not.toContain("legacy");
  });
});
