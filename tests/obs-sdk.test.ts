// Checks the real neatlogs package (pinned in package.json) against the calls src/obs makes. No network:
// init is never called, and nothing is flushed to the ingest endpoint.
//
// The package is imported in a child process, not in this one: tests/obs.test.ts mocks the "neatlogs"
// specifier for the whole test run, and a mock would hide the real exports here.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { InitOptions, TraceOptions } from "neatlogs";

// Compile-time check: these literals fail `bun run typecheck` if the SDK renames an option or kind.
const init: InitOptions = { apiKey: "test-key", workflowName: "roster-review" };
const root: TraceOptions = { name: "review", kind: "WORKFLOW", sessionId: "review-1" };
const leaf: TraceOptions = { name: "ingest", kind: "TOOL" };

const PROBE = `
  const sdk = await import("neatlogs");
  const { wrapOpenAI } = await import("neatlogs/openai");
  const OpenAI = (await import("openai")).default;
  const body = await sdk.trace({ name: "probe", kind: "WORKFLOW" }, async (span) => ({
    value: 7,
    hasSetAttribute: typeof span.setAttribute === "function",
    traceId: typeof span.spanContext === "function" ? span.spanContext().traceId : undefined,
  }));
  const wrapped = wrapOpenAI(new OpenAI({ apiKey: "test-key", baseURL: "http://127.0.0.1:9", maxRetries: 0 }));
  console.log(JSON.stringify({
    types: [typeof sdk.init, typeof sdk.trace, typeof sdk.flush],
    traceArity: sdk.trace.length,
    body,
    createIsFunction: typeof wrapped.chat.completions.create === "function",
  }));
`;

const probe = Bun.spawnSync([process.execPath, "-e", PROBE], {
  cwd: join(import.meta.dir, ".."),
  stdout: "pipe",
  stderr: "pipe",
});
const report = probe.exitCode === 0 ? JSON.parse(probe.stdout.toString().trim().split("\n").at(-1) ?? "{}") : null;

describe("neatlogs exports used by src/obs", () => {
  test("the child process loaded the real package", () => {
    expect(probe.stderr.toString()).toBe("");
    expect(report).not.toBeNull();
  });

  test("init, trace and flush are functions; trace takes (options, body)", () => {
    expect(report?.types).toEqual(["function", "function", "function"]);
    expect(report?.traceArity).toBe(2);
  });

  test("trace runs its body without init and returns the body's value", () => {
    expect(report?.body).toMatchObject({ value: 7, hasSetAttribute: true });
  });

  test("the body's span exposes a span context with a trace id, which src/obs reads", () => {
    expect(typeof report?.body.traceId).toBe("string");
  });

  test("option names src/obs passes are typed (checked at compile time above)", () => {
    expect([init.workflowName, root.kind, leaf.kind]).toEqual(["roster-review", "WORKFLOW", "TOOL"]);
  });
});

describe("neatlogs OpenAI wrapper", () => {
  test("wrapOpenAI returns a client whose chat.completions.create is still a function", () => {
    expect(report?.createIsFunction).toBe(true);
  });
});
