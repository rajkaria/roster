import { describe, expect, test } from "bun:test";
import { validateReport } from "../../src/report/validate.ts";

describe("F30 validateReport", () => {
  test("accepts a minimal valid review report", () => {
    const report = {
      schemaVersion: 1,
      data: {
        repo: "owner/name",
        setups: [{ id: "setup-a" }],
      },
    };

    const result = validateReport("review", report);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("rejects a review report missing data.repo", () => {
    const report = {
      schemaVersion: 1,
      data: {
        setups: [{ id: "setup-a" }],
      },
    };

    const result = validateReport("review", report);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("data.repo: missing");
  });

  test("rejects a review report missing data.setups", () => {
    const report = {
      schemaVersion: 1,
      data: {
        repo: "owner/name",
      },
    };

    const result = validateReport("review", report);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("data.setups: missing");
  });

  test("rejects a review setup missing id", () => {
    const report = {
      schemaVersion: 1,
      data: {
        repo: "owner/name",
        setups: [{ id: "setup-a" }, { label: "missing id" }, { id: "setup-c" }],
      },
    };

    const result = validateReport("review", report);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("data.setups[1].id: missing");
  });

  test("accepts a minimal valid forward report", () => {
    const report = {
      schemaVersion: 1,
      data: {
        pairs: [{ task: "task-a", passOld: true, passNew: false }],
      },
    };

    const result = validateReport("forward", report);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("rejects a forward report missing data.pairs", () => {
    const report = {
      schemaVersion: 1,
      data: {},
    };

    const result = validateReport("forward", report);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("data.pairs: missing");
  });

  test("rejects a forward pair missing task", () => {
    const report = {
      schemaVersion: 1,
      data: {
        pairs: [{ passOld: true, passNew: false }],
      },
    };

    const result = validateReport("forward", report);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("data.pairs[0].task: missing");
  });

  test("rejects a forward pair missing passOld", () => {
    const report = {
      schemaVersion: 1,
      data: {
        pairs: [{ task: "task-a", passNew: false }],
      },
    };

    const result = validateReport("forward", report);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("data.pairs[0].passOld: missing");
  });

  test("rejects a forward pair missing passNew", () => {
    const report = {
      schemaVersion: 1,
      data: {
        pairs: [{ task: "task-a", passOld: true }],
      },
    };

    const result = validateReport("forward", report);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("data.pairs[0].passNew: missing");
  });

  test("accepts a minimal valid book report", () => {
    const report = {
      schemaVersion: 1,
      data: {
        department: [],
      },
    };

    const result = validateReport("book", report);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("rejects a book report missing data.department", () => {
    const report = {
      schemaVersion: 1,
      data: {},
    };

    const result = validateReport("book", report);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("data.department: missing");
  });

  test("accepts a minimal valid corpus report", () => {
    const report = {
      schemaVersion: 1,
      data: {
        rows: [],
        totals: {},
      },
    };

    const result = validateReport("corpus", report);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("rejects a corpus report missing data.rows", () => {
    const report = {
      schemaVersion: 1,
      data: {
        totals: {},
      },
    };

    const result = validateReport("corpus", report);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("data.rows: missing");
  });

  test("rejects a corpus report missing data.totals", () => {
    const report = {
      schemaVersion: 1,
      data: {
        rows: [],
      },
    };

    const result = validateReport("corpus", report);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("data.totals: missing");
  });

  test("rejects a report with missing schemaVersion", () => {
    const report = {
      data: {
        repo: "owner/name",
        setups: [],
      },
    };

    const result = validateReport("review", report);

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.startsWith("schemaVersion"))).toBe(true);
  });

  test("rejects a report with schemaVersion not equal to 1", () => {
    const report = {
      schemaVersion: 2,
      data: {
        repo: "owner/name",
        setups: [],
      },
    };

    const result = validateReport("review", report);

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.startsWith("schemaVersion"))).toBe(true);
  });

  test("rejects a report with schemaVersion '1' as a string", () => {
    const report = {
      schemaVersion: "1",
      data: {
        repo: "owner/name",
        setups: [],
      },
    };

    const result = validateReport("review", report);

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.startsWith("schemaVersion"))).toBe(true);
  });

  test("rejects a review-shaped payload when kind is forward", () => {
    const report = {
      schemaVersion: 1,
      data: {
        repo: "owner/name",
        setups: [{ id: "setup-a" }],
      },
    };

    const result = validateReport("forward", report);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("data.pairs: missing");
  });
});
