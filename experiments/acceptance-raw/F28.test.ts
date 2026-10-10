import { describe, expect, test } from "bun:test";
import { parseJunit } from "../../../src/grade/junit.ts";

describe("parseJunit", () => {
  test("prefers the testcase file attribute", () => {
    const xml = `
      <testsuite name="suiteName" file="suite.test.ts">
        <testcase name="works" file="case.test.ts" />
      </testsuite>`;

    const result = parseJunit(xml, ["case.test.ts"]);

    expect(result.loadFailures).toEqual([]);
    expect(result.tests).toHaveLength(1);
    expect(result.tests[0].file).toBe("case.test.ts");
    expect(result.tests[0].pass).toBe(true);
  });

  test("uses the testsuite file attribute when testcase has no file", () => {
    const xml = `
      <testsuite name="suiteName" file="suite.test.ts">
        <testcase name="works" />
      </testsuite>`;

    const result = parseJunit(xml, ["suite.test.ts"]);

    expect(result.loadFailures).toEqual([]);
    expect(result.tests).toHaveLength(1);
    expect(result.tests[0].file).toBe("suite.test.ts");
    expect(result.tests[0].pass).toBe(true);
  });

  test("falls back to the suite name when no file attributes are present", () => {
    const xml = `
      <testsuite name="my-suite">
        <testcase name="works" />
      </testsuite>`;

    const result = parseJunit(xml, ["my-suite"]);

    expect(result.loadFailures).toEqual([]);
    expect(result.tests).toHaveLength(1);
    expect(result.tests[0].file).toBe("my-suite");
    expect(result.tests[0].pass).toBe(true);
  });

  test("marks testcases with failure or error as failing", () => {
    const xml = `
      <testsuite name="s">
        <testcase name="passes" />
        <testcase name="fails"><failure message="boom" /></testcase>
        <testcase name="errors"><error message="bad" /></testcase>
      </testsuite>`;

    const result = parseJunit(xml, ["s"]);

    expect(result.loadFailures).toEqual([]);
    expect(result.tests).toHaveLength(3);
    for (const entry of result.tests) {
      expect(entry.file).toBe("s");
    }
    expect(result.tests.filter((entry) => entry.pass)).toHaveLength(1);
    expect(result.tests.filter((entry) => !entry.pass)).toHaveLength(2);
  });

  test("excludes skipped testcases", () => {
    const xml = `
      <testsuite name="s">
        <testcase name="kept" />
        <testcase name="skipped"><skipped /></testcase>
      </testsuite>`;

    const result = parseJunit(xml, ["s"]);

    expect(result.loadFailures).toEqual([]);
    expect(result.tests).toHaveLength(1);
    expect(result.tests[0].file).toBe("s");
    expect(result.tests[0].pass).toBe(true);
  });

  test("adds one synthetic failing test per expected file with zero testcases", () => {
    const xml = `
      <testsuite name="suite" file="collected.test.ts">
        <testcase name="present" />
      </testsuite>`;

    const missing = ["missing-a.test.ts", "missing-b.test.ts"];
    const result = parseJunit(xml, ["collected.test.ts", ...missing]);

    expect(result.loadFailures.sort()).toEqual([...missing].sort());
    expect(result.tests).toHaveLength(3);

    const synthetics = result.tests.filter(
      (entry) => entry.name === "0 tests collected: load error",
    );
    expect(synthetics).toHaveLength(2);

    for (const file of missing) {
      expect(synthetics).toContainEqual({
        file,
        name: "0 tests collected: load error",
        pass: false,
      });
    }
  });

  test("returns only synthetic failures for empty XML", () => {
    const result = parseJunit("", ["only.test.ts"]);

    expect(result.loadFailures).toEqual(["only.test.ts"]);
    expect(result.tests).toEqual([
      {
        file: "only.test.ts",
        name: "0 tests collected: load error",
        pass: false,
      },
    ]);
  });
});
