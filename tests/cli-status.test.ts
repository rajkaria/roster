// F22: `roster status` — where the latest run is, from its step log (experiments/acceptance/F22).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/agent/coordinator.ts";
import { parseStatusArgs, readStatusLog, renderStatus, type StatusEvent } from "../src/cli/status.ts";

const WORK = mkdtempSync(join(tmpdir(), "roster-status-"));
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

function ev(runId: string, step: string, status: StatusEvent["status"], at: string, costUsd?: number): StatusEvent {
  return costUsd === undefined ? { runId, step, status, at } : { runId, step, status, at, costUsd };
}

describe("renderStatus", () => {
  test("returns no runs yet when there are no events", () => {
    expect(renderStatus([], 100).trim()).toBe("no runs yet");
  });

  test("renders the latest run: last completed step, in-progress step, failed step, cost vs budget", () => {
    const events = [
      ev("old", "legacy", "done", "2024-01-01T00:00:00Z", 10),
      ev("latest", "plan", "done", "2024-01-02T00:00:00Z"),
      ev("latest", "edit", "started", "2024-01-02T00:01:00Z"),
      ev("latest", "test", "failed", "2024-01-02T00:02:00Z"),
      ev("latest", "report", "done", "2024-01-02T00:03:00Z", 0.6),
    ];
    const output = renderStatus(events, 5);
    expect(output).toBe(
      ["run latest", "last completed step: report", "in progress: edit", "failed steps: test", "cost: $0.60 of $5.00"].join("\n"),
    );
  });

  test("only the latest run's steps and cost count", () => {
    const events = [
      ev("a", "one", "done", "2024-01-01T00:00:00Z", 100),
      ev("b", "three", "done", "2024-01-02T00:00:00Z", 1.005),
      ev("b", "two", "failed", "2024-01-02T00:01:00Z"),
      // Interleaved: b's events sit in the middle though a finished last.
      ev("a", "done", "done", "2024-01-03T00:00:00Z", 7),
    ];
    const output = renderStatus(events, 2);
    expect(output).toContain("run a");
    expect(output).toContain("last completed step: done");
    expect(output).not.toContain("three");
    expect(output).not.toContain("two");
    expect(output).toBe(["run a", "last completed step: done", "cost: $107.00 of $2.00"].join("\n"));
  });

  test("a step that started and then finished is not in progress; one that failed last is a failure", () => {
    const events = [
      ev("r", "clone", "started", "2024-05-01T00:00:00Z"),
      ev("r", "clone", "done", "2024-05-01T00:01:00Z"),
      ev("r", "grade", "started", "2024-05-01T00:02:00Z"),
      ev("r", "grade", "failed", "2024-05-01T00:03:00Z"),
      ev("r", "grade", "started", "2024-05-01T00:04:00Z"),
    ];
    const output = renderStatus(events, 1);
    expect(output).toContain("last completed step: clone");
    expect(output).toContain("in progress: grade");
    expect(output).not.toContain("failed steps");
  });

  test("a step that failed and was retried to done is a completion, not a failure", () => {
    const events = [
      ev("r", "plan", "failed", "not a date"),
      ev("r", "plan", "done", "2024-01-01T00:00:00Z"),
      ev("r", "gate", "done", "2024-01-01T00:01:00Z"),
      ev("r", "revert", "failed", "2024-01-01T00:02:00Z"),
    ];
    const output = renderStatus(events, 0);
    expect(output).toBe(["run r", "last completed step: gate", "failed steps: revert", "cost: $0.00 of $0.00"].join("\n"));
  });

  test("unparseable timestamps are ignored, and a log with none at all falls back to log order", () => {
    const undated = [ev("first", "a", "done", "?"), ev("second", "b", "failed", "-")];
    expect(renderStatus(undated, 1)).toBe(["run second", "failed steps: b", "cost: $0.00 of $1.00"].join("\n"));
  });

  test("cost is the latest run's total to the cent, and a non-finite budget does not print NaN", () => {
    const events = [ev("r", "a", "done", "2024-01-01T00:00:00Z", 0.005), ev("r", "b", "done", "2024-01-01T00:01:00Z", 1.994)];
    expect(renderStatus(events, Number.NaN)).toContain("cost: $2.00 of $0.00");
  });

  test("a run with no completed step still reports its state", () => {
    const events = [ev("r", "plan", "started", "2024-01-01T00:00:00Z")];
    expect(renderStatus(events, 3)).toBe(["run r", "in progress: plan", "cost: $0.00 of $3.00"].join("\n"));
  });
});

// The command reads the log `roster run` writes: the same EventStore, with the payloads the coordinator appends
// (coordinator.ts: log("tool", {name, ok}), log("llm", {costUsd}), log("note", {llm_error}), log("end", {result})).
function buildDb(name: string): string {
  const dbPath = join(WORK, name, "roster.db");
  const store = new EventStore(dbPath);
  const at = (s: number) => new Date(Date.UTC(2026, 9, 11, 10, 0, s));
  store.append("run-old", "start", { messages: [], config: { repo: "acme/repo", budgetUsd: 1, reviewId: "run-old" } }, at(0));
  store.append("run-old", "tool", { name: "get_scorecard", ok: true }, at(1));
  store.append("run-old", "end", { result: { runId: "run-old" } }, at(2));
  store.append("run-1", "start", { messages: [], config: { repo: "acme/repo", budgetUsd: 5, reviewId: "run-1" } }, at(10));
  store.append("run-1", "tool", { name: "get_scorecard", ok: true }, at(11));
  store.append("run-1", "llm", { message: {}, costUsd: 0.25, usage: {}, model: "deepseek-flash" }, at(12));
  store.append("run-1", "tool", { name: "gate", ok: false }, at(13));
  store.append("run-1", "note", { llm_error: { message: "429", attempts: 3 } }, at(14));
  store.close();
  return dbPath;
}

describe("readStatusLog", () => {
  test("maps the coordinator's events to steps and reads the latest run's budget", () => {
    const log = readStatusLog(buildDb("good"));
    expect(log.budgetUsd).toBe(5);
    expect(log.events.filter((e) => e.runId === "run-1").map((e) => `${e.step}:${e.status}`)).toEqual([
      "get_scorecard:done",
      "llm:done",
      "gate:failed",
      "llm:failed",
    ]);
    expect(log.events.find((e) => e.step === "llm" && e.status === "done")?.costUsd).toBe(0.25);
    expect(log.events.some((e) => e.runId === "run-old")).toBe(true);
    // run-1's last done event is its first llm turn, but that step's last word is the 429 → not a completion.
    expect(renderStatus(log.events, log.budgetUsd ?? 0)).toBe(
      ["run run-1", "last completed step: get_scorecard", "failed steps: llm, gate", "cost: $0.25 of $5.00"].join("\n"),
    );
  });

  test("a missing database and a foreign database read as no events", () => {
    expect(readStatusLog(join(WORK, "nope", "roster.db"))).toEqual({ events: [], budgetUsd: undefined });
    const foreign = join(WORK, "foreign", "other.db");
    const store = new EventStore(foreign); // tables exist, no rows
    store.close();
    expect(readStatusLog(foreign).events).toEqual([]);
  });
});

describe("roster status", () => {
  const CLI = join(import.meta.dir, "..", "src", "cli", "status.ts");

  function runCli(args: string[]) {
    const p = Bun.spawnSync([process.execPath, CLI, ...args], { stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
  }

  test("prints the latest run's state, budget recorded in its start event", () => {
    const r = runCli(["--db", buildDb("cli")]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      ["run run-1", "last completed step: get_scorecard", "failed steps: llm, gate", "cost: $0.25 of $5.00", ""].join("\n"),
    );
  });

  test("--budget overrides the recorded budget", () => {
    const r = runCli(["--db", buildDb("cli-budget"), "--budget", "2.5"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("cost: $0.25 of $2.50");
  });

  test("says no runs yet for a database with no events, and rejects bad arguments", () => {
    expect(runCli(["--db", join(WORK, "missing.db")])).toMatchObject({ code: 0, stdout: "no runs yet\n" });
    const bad = runCli(["--budget", "lots"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("--budget must be a non-negative number");
    const unknown = runCli(["--nope"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("unexpected argument --nope");
  });
});

describe("parseStatusArgs", () => {
  test("defaults to the state database and no budget override", () => {
    expect(parseStatusArgs([])).toEqual({ db: ".roster/roster.db", budgetUsd: undefined });
    expect(parseStatusArgs(["--db=x.db", "--budget=0"])).toEqual({ db: "x.db", budgetUsd: 0 });
  });

  test("rejects a flag without a value", () => {
    expect(() => parseStatusArgs(["--db"])).toThrow("--db needs a value");
  });
});
