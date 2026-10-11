import { describe, expect, test } from "bun:test";
import { SCHEMA_VERSION, validateReport } from "../src/report/validate.ts";

/** A report that passes for the given kind, so one field can be removed or corrupted per test. */
function report(kind: "review" | "forward" | "book" | "corpus"): Record<string, unknown> {
  const data: Record<string, unknown> = {
    review: { repo: "owner/name", setups: [{ id: "setup-a" }] },
    forward: { pairs: [{ task: "task-a", passOld: true, passNew: false }] },
    book: { department: [] },
    corpus: { rows: [], totals: {} },
  }[kind];
  return { schemaVersion: SCHEMA_VERSION, generatedAt: "2026-01-01T00:00:00.000Z", data };
}

describe("validateReport schema version", () => {
  test("accepts schemaVersion 1", () => {
    expect(validateReport("review", report("review"))).toEqual({ ok: true, errors: [] });
  });

  test("rejects a missing schemaVersion", () => {
    const json = report("review");
    delete json.schemaVersion;
    const result = validateReport("review", json);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("schemaVersion: missing");
  });

  test("rejects a numeric schemaVersion other than 1", () => {
    const result = validateReport("review", { ...report("review"), schemaVersion: 2 });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("schemaVersion: expected 1, got 2");
  });

  test("rejects schemaVersion given as a string", () => {
    const result = validateReport("review", { ...report("review"), schemaVersion: "1" });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('schemaVersion: expected 1, got "1"');
  });

  test("reports every problem, not just the first", () => {
    const result = validateReport("review", { schemaVersion: 2, data: {} });
    expect(result.errors).toEqual([
      "schemaVersion: expected 1, got 2",
      "data.repo: missing",
      "data.setups: missing",
    ]);
  });
});

describe("validateReport root and data shape", () => {
  test("rejects a non-object payload", () => {
    for (const json of [null, undefined, 42, "report", [{ schemaVersion: 1 }]]) {
      const result = validateReport("review", json);
      expect(result.ok).toBe(false);
      expect(result.errors).toEqual(["root: expected object"]);
    }
  });

  test("rejects a missing data object", () => {
    const result = validateReport("book", { schemaVersion: 1 });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("data: missing");
    expect(result.errors).toContain("data.department: missing");
  });

  test("rejects a non-object data value", () => {
    const result = validateReport("book", { schemaVersion: 1, data: [] });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("data: expected object");
  });
});

describe("validateReport review", () => {
  test("accepts a minimal review report", () => {
    const result = validateReport("review", report("review"));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("rejects a missing data.repo", () => {
    const result = validateReport("review", { schemaVersion: 1, data: { setups: [{ id: "setup-a" }] } });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("data.repo: missing");
  });

  test("rejects a non-string data.repo", () => {
    const result = validateReport("review", { schemaVersion: 1, data: { repo: 7, setups: [] } });
    expect(result.errors).toContain("data.repo: expected string");
  });

  test("rejects a missing data.setups", () => {
    const result = validateReport("review", { schemaVersion: 1, data: { repo: "owner/name" } });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("data.setups: missing");
  });

  test("rejects a non-array data.setups", () => {
    const result = validateReport("review", { schemaVersion: 1, data: { repo: "owner/name", setups: {} } });
    expect(result.errors).toContain("data.setups: expected array");
  });

  test("points at the setup index missing an id", () => {
    const result = validateReport("review", {
      schemaVersion: 1,
      data: { repo: "owner/name", setups: [{ id: "setup-a" }, { label: "missing id" }, { id: "setup-c" }] },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["data.setups[1].id: missing"]);
  });

  test("rejects a non-string setup id", () => {
    const result = validateReport("review", { schemaVersion: 1, data: { repo: "owner/name", setups: [{ id: 3 }] } });
    expect(result.errors).toContain("data.setups[0].id: expected string");
  });

  test("rejects a non-object setup entry", () => {
    const result = validateReport("review", { schemaVersion: 1, data: { repo: "owner/name", setups: ["setup-a"] } });
    expect(result.errors).toContain("data.setups[0]: expected object");
  });
});

describe("validateReport forward", () => {
  test("accepts a minimal forward report", () => {
    const result = validateReport("forward", report("forward"));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("treats false passOld/passNew as present", () => {
    const result = validateReport("forward", {
      schemaVersion: 1,
      data: { pairs: [{ task: "task-a", passOld: false, passNew: false }] },
    });
    expect(result).toEqual({ ok: true, errors: [] });
  });

  test("rejects a missing data.pairs", () => {
    const result = validateReport("forward", { schemaVersion: 1, data: {} });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("data.pairs: missing");
  });

  test("names each missing pair field", () => {
    const result = validateReport("forward", {
      schemaVersion: 1,
      data: { pairs: [{ passOld: true, passNew: false }, { task: "task-b", passNew: false }, { task: "task-c", passOld: true }] },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      "data.pairs[0].task: missing",
      "data.pairs[1].passOld: missing",
      "data.pairs[2].passNew: missing",
    ]);
  });

  test("rejects non-boolean pass flags", () => {
    const result = validateReport("forward", {
      schemaVersion: 1,
      data: { pairs: [{ task: "task-a", passOld: "true", passNew: 1 }] },
    });
    expect(result.errors).toContain("data.pairs[0].passOld: expected boolean");
    expect(result.errors).toContain("data.pairs[0].passNew: expected boolean");
  });

  test("rejects a review-shaped payload", () => {
    const result = validateReport("forward", report("review"));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("data.pairs: missing");
  });
});

describe("validateReport book", () => {
  test("accepts an empty department", () => {
    expect(validateReport("book", report("book"))).toEqual({ ok: true, errors: [] });
  });

  test("rejects a missing data.department", () => {
    const result = validateReport("book", { schemaVersion: 1, data: {} });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("data.department: missing");
  });

  test("rejects a non-array department", () => {
    const result = validateReport("book", { schemaVersion: 1, data: { department: { spend: 1 } } });
    expect(result.errors).toContain("data.department: expected array");
  });
});

describe("validateReport corpus", () => {
  test("accepts empty rows and totals", () => {
    expect(validateReport("corpus", report("corpus"))).toEqual({ ok: true, errors: [] });
  });

  test("rejects a missing data.rows", () => {
    const result = validateReport("corpus", { schemaVersion: 1, data: { totals: {} } });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("data.rows: missing");
  });

  test("rejects a missing data.totals", () => {
    const result = validateReport("corpus", { schemaVersion: 1, data: { rows: [] } });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("data.totals: missing");
  });

  test("rejects a non-object totals", () => {
    const result = validateReport("corpus", { schemaVersion: 1, data: { rows: [], totals: 0 } });
    expect(result.errors).toContain("data.totals: expected object");
  });
});
