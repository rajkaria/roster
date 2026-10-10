import { describe, expect, test } from "bun:test";
import { renderPrBody } from "../../../src/act/pr-body.ts";

function section(text: string, start: string, end?: string): string {
  const startIndex = text.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = end === undefined ? text.length : text.indexOf(end, startIndex);
  return text.slice(startIndex, endIndex === -1 ? text.length : endIndex);
}

const baseInput = {
  repo: "owner/repo",
  incumbent: "setup-old",
  promoted: "setup-new",
  tasks: [
    {
      id: "task-basic",
      incumbentPass: true,
      candidatePass: true,
      costUsd: 1.25,
    },
  ],
  rejected: [] as { candidate: string; reasons: string[] }[],
  evidenceLevel: "B" as const,
};

describe("renderPrBody", () => {
  test("renders required sections", () => {
    const output = renderPrBody(baseInput);
    expect(output).toContain("Summary");
    expect(output).toContain("Evidence");
    expect(output).toContain("Rejected candidates");
    expect(output).toContain("Links");
  });

  test("totals line counts candidate and incumbent passes from input", () => {
    const input = {
      ...baseInput,
      tasks: [
        { id: "a", incumbentPass: true, candidatePass: true, costUsd: 1 },
        { id: "b", incumbentPass: false, candidatePass: true, costUsd: 2 },
        { id: "c", incumbentPass: true, candidatePass: false, costUsd: 3 },
      ],
    };
    const output = renderPrBody(input);
    expect(output).toContain("2 of 3 tasks passed (incumbent 2 of 3)");
  });

  test("evidence table shows ✓/✗, formats costs to two decimals, and uses n/a for null", () => {
    const input = {
      ...baseInput,
      tasks: [
        { id: "task-1", incumbentPass: false, candidatePass: true, costUsd: 12.345 },
        { id: "task-2", incumbentPass: true, candidatePass: false, costUsd: null },
        { id: "task-3", incumbentPass: true, candidatePass: true, costUsd: 0 },
      ],
    };
    const output = renderPrBody(input);
    const evidence = section(output, "Evidence", "Rejected candidates");

    const task1 = evidence.split("\n").find((line) => line.includes("task-1"));
    const task2 = evidence.split("\n").find((line) => line.includes("task-2"));
    const task3 = evidence.split("\n").find((line) => line.includes("task-3"));

    expect(task1).toBeDefined();
    expect(task1).toContain("✓");
    expect(task1).toContain("✗");
    expect(task1).toContain("12.35");

    expect(task2).toBeDefined();
    expect(task2).toContain("✓");
    expect(task2).toContain("✗");
    expect(task2).toContain("n/a");

    expect(task3).toBeDefined();
    expect(task3).toContain("✓");
    expect(task3).toContain("0.00");
  });

  test("rejected candidates are listed with their reasons", () => {
    const input = {
      ...baseInput,
      rejected: [
        { candidate: "setup-old", reasons: ["low pass rate", "high cost"] },
        { candidate: "setup-alt", reasons: ["hidden tests failed"] },
      ],
    };
    const output = renderPrBody(input);
    const rejectedSection = section(output, "Rejected candidates", "Links");

    expect(rejectedSection).toContain("setup-old");
    expect(rejectedSection).toContain("low pass rate");
    expect(rejectedSection).toContain("high cost");
    expect(rejectedSection).toContain("setup-alt");
    expect(rejectedSection).toContain("hidden tests failed");
  });

  test("empty rejected list says None", () => {
    const output = renderPrBody(baseInput);
    const rejectedSection = section(output, "Rejected candidates", "Links");
    expect(rejectedSection).toContain("None");
  });

  test("links section includes trace and entire URLs from tasks", () => {
    const input = {
      ...baseInput,
      tasks: [
        {
          id: "task-linked",
          incumbentPass: true,
          candidatePass: true,
          costUsd: 1.25,
          traceUrl: "https://trace.example/task-linked",
          entireUrl: "https://entire.example/task-linked",
        },
      ],
    };
    const output = renderPrBody(input);
    const linksSection = section(output, "Links");

    expect(linksSection).toContain("https://trace.example/task-linked");
    expect(linksSection).toContain("https://entire.example/task-linked");
  });

  test("does not add subjective adjectives", () => {
    const output = renderPrBody(baseInput);
    expect(output).not.toContain("significant");
    expect(output).not.toContain("best");
  });
});
