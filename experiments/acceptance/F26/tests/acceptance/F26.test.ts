import { describe, expect, test } from "bun:test";
import { checkEligibility } from "../../src/replay/eligibility.ts";

describe("checkEligibility", () => {
  test("import strategy returns track none with imported history and skips probe", async () => {
    let probeCalled = false;

    const result = await checkEligibility(
      { userPrompts: 1, hiddenTests: ["test.ts"], strategy: "import" },
      async () => {
        probeCalled = true;
        return { installs: true, suitePasses: true };
      },
    );

    expect(result).toEqual({
      eligible: false,
      track: "none",
      reason: "imported history",
    });
    expect(probeCalled).toBe(false);
  });

  test("more than two user prompts returns track none and skips probe", async () => {
    let probeCalled = false;

    const result = await checkEligibility(
      { userPrompts: 3, hiddenTests: ["test.ts"], strategy: "normal" },
      async () => {
        probeCalled = true;
        return { installs: true, suitePasses: true };
      },
    );

    expect(result.eligible).toBe(false);
    expect(result.track).toBe("none");
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
    expect(probeCalled).toBe(false);
  });

  test("when probe fails to install returns parent does not install", async () => {
    let probeCalled = false;

    const result = await checkEligibility(
      { userPrompts: 1, hiddenTests: ["test.ts"], strategy: "normal" },
      async () => {
        probeCalled = true;
        return { installs: false, suitePasses: true };
      },
    );

    expect(probeCalled).toBe(true);
    expect(result.eligible).toBe(false);
    expect(result.track).toBe("none");
    expect(result.reason).toBe("parent does not install");
  });

  test("when parent suite fails returns track none", async () => {
    const result = await checkEligibility(
      { userPrompts: 1, hiddenTests: ["test.ts"], strategy: "normal" },
      async () => ({ installs: true, suitePasses: false }),
    );

    expect(result.eligible).toBe(false);
    expect(result.track).toBe("none");
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  test("with no hidden tests returns eligible judge-only", async () => {
    let probeCalled = false;

    const result = await checkEligibility(
      { userPrompts: 1, hiddenTests: [], strategy: "normal" },
      async () => {
        probeCalled = true;
        return { installs: true, suitePasses: true };
      },
    );

    expect(probeCalled).toBe(true);
    expect(result.eligible).toBe(true);
    expect(result.track).toBe("judge-only");
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  test("with hidden tests and healthy probe returns eligible track tests", async () => {
    const result = await checkEligibility(
      { userPrompts: 2, hiddenTests: ["test.ts"], strategy: "normal" },
      async () => ({ installs: true, suitePasses: true }),
    );

    expect(result.eligible).toBe(true);
    expect(result.track).toBe("tests");
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
  });
});
