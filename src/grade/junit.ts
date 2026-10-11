/**
 * Per-test results from a JUnit XML report (design: Grade step 3).
 *
 * The report is a run's evidence, so its gaps matter as much as its rows: bun's JUnit reporter silently omits a test
 * file that fails at import (a syntax error, a throw at module scope, or no tests at all), which would otherwise look
 * like "that hidden file had no failures". `parseJunit` therefore takes the files the run was supposed to cover and
 * synthesises one failing test for every expected file that left no trace, listing it in `loadFailures`.
 *
 * No XML dependency: the reports we read are machine-generated and shallow (`testsuites > testsuite > testcase`), so
 * a small element tokenizer is enough.
 */

export interface JunitTest {
  file: string;
  name: string;
  pass: boolean;
}

export interface JunitResult {
  tests: JunitTest[];
  loadFailures: string[];
}

/** The exact name of the synthetic test for an expected file that produced no testcases. */
export const LOAD_ERROR_NAME = "0 tests collected: load error";

// Only the three element kinds we care about, so attribute values that happen to contain "<" cannot start a tag.
const TOKEN =
  /<testsuite\b[^>]*?\/>|<testsuite\b[^>]*>|<\/testsuite>|<testcase\b[^>]*?\/>|<testcase\b[^>]*>[\s\S]*?<\/testcase>/g;

const unescape = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** An attribute's value, unescaped; undefined when absent so callers can tell "" from "not set". */
function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  if (!m) return undefined;
  return unescape(m[1] ?? m[2] ?? "");
}

/** Paths are compared the way the grader writes them: forward slashes, no leading "./". */
const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

interface Suite {
  file?: string;
  name: string;
}

/**
 * Every testcase in `xml` as a pass/fail result, plus the expected files the reporter never mentioned.
 *
 * A case's file is its own `file` attribute, else the nearest enclosing `testsuite` that names one, else the
 * innermost suite's name. `<failure>` or `<error>` fails a case; a `<skipped>` case is not a result at all. Skips
 * still count as evidence the file loaded, so a file whose cases were all skipped is not a load failure.
 */
export function parseJunit(xml: string, expectedFiles: string[]): JunitResult {
  const tests: JunitTest[] = [];
  /** Normalized files that produced at least one testcase element, skipped cases included. */
  const collected = new Set<string>();
  const suites: Suite[] = [];

  for (const token of xml.match(TOKEN) ?? []) {
    if (token.startsWith("</testsuite")) {
      suites.pop();
      continue;
    }
    if (token.startsWith("<testsuite")) {
      if (token.endsWith("/>")) continue; // an empty suite opens no scope
      suites.push({ file: attr(token, "file"), name: attr(token, "name") ?? "" });
      continue;
    }

    const head = token.slice(0, token.indexOf(">") + 1);
    const body = token.endsWith("/>") ? "" : token.slice(token.indexOf(">") + 1, token.lastIndexOf("</testcase>"));

    let file = attr(head, "file");
    if (file === undefined) {
      for (let i = suites.length - 1; i >= 0; i--) {
        const f = suites[i]?.file;
        if (f !== undefined) {
          file = f;
          break;
        }
      }
    }
    if (file === undefined) file = suites.at(-1)?.name ?? "";
    file = norm(file);

    const failed = /<(failure|error)\b/.test(body);
    collected.add(file);
    if (!failed && /<skipped\b/.test(body)) continue; // skipped: the file loaded, but the case is not a result
    tests.push({ file, name: attr(head, "name") ?? "", pass: !failed });
  }

  const expected = new Map<string, string>(); // normalized -> as given, first spelling wins
  for (const f of expectedFiles) if (!expected.has(norm(f))) expected.set(norm(f), f);

  const loadFailures: string[] = [];
  for (const [key, given] of expected) {
    if (collected.has(key)) continue;
    loadFailures.push(given);
    tests.push({ file: given, name: LOAD_ERROR_NAME, pass: false });
  }

  return { tests, loadFailures };
}
