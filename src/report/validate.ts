// Report validators. Reports are exported as `{ schemaVersion, generatedAt, data }`, so a malformed
// file must be rejected before it reaches the site's prebuild or the FACTS generator.
// Every error is a JSON-path string, e.g. "data.setups[2].id: missing".

/** The report files this validator knows about. */
export type ReportKind = "review" | "forward" | "book" | "corpus";

/** Result of {@link validateReport}. `errors` is empty exactly when `ok` is true. */
export interface ReportValidation {
  ok: boolean;
  errors: string[];
}

/** The only report schema version this validator accepts. */
export const SCHEMA_VERSION = 1;

/** One required field: read `key` from `obj` and check it against `path` in the error message. */
type Field = (obj: Record<string, unknown> | undefined, key: string, path: string) => unknown;

/** `undefined` and `null` count as absent; a stored `false` or `0` is present. */
function present(obj: Record<string, unknown> | undefined, key: string): boolean {
  return obj !== undefined && Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined && obj[key] !== null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Renders a rejected value for the error message. */
function show(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Validates one exported report.
 *
 * Checks `schemaVersion === SCHEMA_VERSION` and the required fields for `kind`:
 * review needs `data.repo` and `data.setups[]` (each with an `id`); forward needs `data.pairs[]`
 * (each with `task`, `passOld`, `passNew`); book needs `data.department[]`; corpus needs
 * `data.rows[]` and `data.totals`. All errors are collected, not just the first.
 */
export function validateReport(kind: ReportKind, json: unknown): ReportValidation {
  const errors: string[] = [];

  if (!isPlainObject(json)) return { ok: false, errors: ["root: expected object"] };

  if (!present(json, "schemaVersion")) errors.push("schemaVersion: missing");
  else if (json.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion: expected ${SCHEMA_VERSION}, got ${show(json.schemaVersion)}`);
  }

  const rawData = json.data;
  if (rawData === undefined || rawData === null) errors.push("data: missing");
  else if (!isPlainObject(rawData)) errors.push("data: expected object");
  const data = isPlainObject(rawData) ? rawData : undefined;

  /** A required array field; on failure the value is reported and `undefined` returned. */
  const reqArray: Field = (obj, key, path) => {
    if (!present(obj, key)) {
      errors.push(`${path}: missing`);
      return undefined;
    }
    const value = obj![key];
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected array`);
      return undefined;
    }
    return value;
  };

  const reqObject: Field = (obj, key, path) => {
    if (!present(obj, key)) {
      errors.push(`${path}: missing`);
      return undefined;
    }
    const value = obj![key];
    if (!isPlainObject(value)) {
      errors.push(`${path}: expected object`);
      return undefined;
    }
    return value;
  };

  const reqString: Field = (obj, key, path) => {
    if (!present(obj, key)) {
      errors.push(`${path}: missing`);
      return undefined;
    }
    if (typeof obj![key] !== "string") {
      errors.push(`${path}: expected string`);
      return undefined;
    }
    return obj![key];
  };

  const reqBoolean: Field = (obj, key, path) => {
    if (!present(obj, key)) {
      errors.push(`${path}: missing`);
      return undefined;
    }
    if (typeof obj![key] !== "boolean") {
      errors.push(`${path}: expected boolean`);
      return undefined;
    }
    return obj![key];
  };

  /** Visits each element of a required array, reporting non-object entries with their index. */
  const elements = (value: unknown, path: string, visit: (item: Record<string, unknown>, index: number) => void): void => {
    if (!Array.isArray(value)) return;
    value.forEach((item, index) => {
      if (!isPlainObject(item)) {
        errors.push(`${path}[${index}]: expected object`);
        return;
      }
      visit(item, index);
    });
  };

  switch (kind) {
    case "review": {
      reqString(data, "repo", "data.repo");
      const setups = reqArray(data, "setups", "data.setups");
      elements(setups, "data.setups", (setup, index) => reqString(setup, "id", `data.setups[${index}].id`));
      break;
    }
    case "forward": {
      const pairs = reqArray(data, "pairs", "data.pairs");
      elements(pairs, "data.pairs", (pair, index) => {
        reqString(pair, "task", `data.pairs[${index}].task`);
        reqBoolean(pair, "passOld", `data.pairs[${index}].passOld`);
        reqBoolean(pair, "passNew", `data.pairs[${index}].passNew`);
      });
      break;
    }
    case "book": {
      reqArray(data, "department", "data.department");
      break;
    }
    case "corpus": {
      reqArray(data, "rows", "data.rows");
      reqObject(data, "totals", "data.totals");
      break;
    }
    default: {
      errors.push(`kind: unknown report kind ${show(kind)}`);
      break;
    }
  }

  return { ok: errors.length === 0, errors };
}
