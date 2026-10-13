// Live /try (post-deadline): the form's states for a live review, from the POST answer through each poll.
import { describe, expect, test } from "bun:test";
import { elapsed, GIVE_UP_MS, mapPoll, mapResponse, type TryState } from "../web/components/tryState.ts";

const IN = "https://github.com/octo/cat";
type Running = Extract<TryState, { kind: "running" }>;
const running = (over: Partial<Running> = {}): Running => ({
  kind: "running",
  job: "job-123456",
  repo: "Octo/Cat",
  stage: "queued",
  runUrl: null,
  startedAt: 1_000,
  ...over,
});

describe("mapResponse, live", () => {
  test("202 with a job starts a running review under the canonical name", () => {
    expect(mapResponse(202, { job: "job-123456", repo: "Octo/Cat" }, IN, 1_000)).toEqual(running());
  });
  test("202 without a job is still the run-it-yourself answer", () => {
    expect(mapResponse(202, { queued: true }, IN).kind).toBe("queued");
  });
  test("a live cache hit links to the API's href and says it is current", () => {
    expect(mapResponse(200, { cached: true, live: true, href: "/r/Octo/Cat" }, IN)).toEqual({ kind: "cached", href: "/r/Octo/Cat", label: "Octo/Cat", live: true });
  });
  test("no Entire data gets its own state", () => {
    expect(mapResponse(422, { error: "no_entire_data", repo: "Octo/Cat" }, IN)).toEqual({ kind: "no_entire_data", repo: "Octo/Cat" });
  });
  test("refusals show the API's message", () => {
    for (const status of [403, 404, 413, 502, 503]) {
      expect(mapResponse(status, { error: "x", message: "why" }, IN)).toEqual({ kind: "refused", message: "why" });
    }
    expect(mapResponse(503, {}, IN).kind).toBe("error");
  });
});

describe("mapPoll", () => {
  test("queued keeps waiting and picks up the run log", () => {
    expect(mapPoll(running(), 200, { state: "queued", run_url: "https://run" }, 2_000)).toEqual(running({ runUrl: "https://run" }));
  });
  test("running moves the stage forward, never back", () => {
    const r = mapPoll(running(), 200, { state: "running", stage: "reviewing" }, 2_000) as Running;
    expect(r.stage).toBe("reviewing");
    expect((mapPoll(r, 200, { state: "running", stage: "starting" }, 3_000) as Running).stage).toBe("reviewing");
    expect((mapPoll(running(), 200, { state: "running", stage: "queued" }, 2_000) as Running).stage).toBe("starting");
  });
  test("done opens the review", () => {
    expect(mapPoll(running(), 200, { state: "done", href: "/r/Octo/Cat", run_url: "u" }, 2_000)).toEqual({ kind: "done", href: "/r/Octo/Cat", label: "Octo/Cat", runUrl: "u" });
  });
  test("failures carry the message and the run log; no Entire data has its own state", () => {
    expect(mapPoll(running(), 200, { state: "failed", error: "failed", message: "boom", run_url: "u" }, 2_000)).toEqual({ kind: "failed", message: "boom", runUrl: "u" });
    expect(mapPoll(running(), 200, { state: "failed", error: "no_entire_data" }, 2_000)).toEqual({ kind: "no_entire_data", repo: "Octo/Cat" });
  });
  test("a failed poll or an unknown answer changes nothing", () => {
    const r = running({ stage: "reviewing" });
    expect(mapPoll(r, 502, { error: "github_unreachable" }, 2_000)).toBe(r);
    expect(mapPoll(r, 200, null, 2_000)).toBe(r);
    expect(mapPoll(r, 200, { state: "weird" }, 2_000)).toBe(r);
  });
  test("after the give-up time it stops and points at the run log", () => {
    const r = running({ runUrl: "u" });
    expect(mapPoll(r, 200, { state: "running", stage: "reviewing" }, r.startedAt + GIVE_UP_MS + 1)).toMatchObject({ kind: "failed", runUrl: "u" });
  });
});

test("elapsed", () => {
  expect([elapsed(0), elapsed(65_000), elapsed(-5)]).toEqual(["0:00", "1:05", "0:00"]);
});
