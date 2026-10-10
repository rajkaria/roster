import { describe, expect, test } from "bun:test";
import { renderLlms } from "../../../scripts/llms.ts";

const repoUrl = "https://github.com/acme/roster";

function makeInput(overrides: Partial<Parameters<typeof renderLlms>[0]> = {}) {
  return {
    readme: [
      "# Roster repo",
      "",
      "Intro paragraph.",
      "",
      "> First blockquote line",
      "> second blockquote line",
      "",
      "Another paragraph.",
    ].join("\n"),
    designHeadings: ["Data model", "Failure taxonomy", "Plan (coordinator)"],
    facts: "First fact line\nPENDING: Verify second fact\nThird fact line",
    repoUrl,
    ...overrides,
  };
}

describe("renderLlms", () => {
  test("starts with # Roster followed by the README's first blockquote line", () => {
    const output = renderLlms(makeInput());

    expect(output.startsWith("# Roster")).toBe(true);
    expect(output).toContain("> First blockquote line");
    expect(output).not.toContain("> second blockquote line");
  });

  test("renders sections in order", () => {
    const output = renderLlms(makeInput());

    const roster = output.indexOf("# Roster");
    const docs = output.indexOf("## Docs");
    const design = output.indexOf("## Design sections");
    const facts = output.indexOf("## Facts");

    expect(roster).toBeGreaterThanOrEqual(0);
    expect(docs).toBeGreaterThan(roster);
    expect(design).toBeGreaterThan(docs);
    expect(facts).toBeGreaterThan(design);
  });

  test("Docs section links to absolute GitHub URLs", () => {
    const output = renderLlms(makeInput());

    expect(output).toContain(
      `[docs/DESIGN.md](${repoUrl}/blob/main/docs/DESIGN.md)`,
    );
    expect(output).toContain(
      `[experiments/PREREGISTRATION.md](${repoUrl}/blob/main/experiments/PREREGISTRATION.md)`,
    );
    expect(output).toContain(
      `[docs/FACTS.md](${repoUrl}/blob/main/docs/FACTS.md)`,
    );
  });

  test("Design sections list contains the provided headings", () => {
    const output = renderLlms(makeInput());

    expect(output).toContain("- Data model");
    expect(output).toContain("- Failure taxonomy");
    expect(output).toContain("- Plan (coordinator)");
  });

  test("Facts section copies FACTS lines and keeps PENDING", () => {
    const output = renderLlms(makeInput());

    expect(output).toContain("First fact line");
    expect(output).toContain("PENDING: Verify second fact");
    expect(output).toContain("Third fact line");
  });
});
