// T71: the /try form's mapping from API status to page state.
import { describe, expect, test } from "bun:test";
import { mapResponse, repoFromInput } from "../web/components/tryState.ts";

const URL_IN = "https://github.com/octo/cat";

describe("mapResponse", () => {
  test("400 shows the API's message", () => {
    expect(mapResponse(400, { error: "not a GitHub repository reference" }, "nope")).toEqual({
      kind: "invalid",
      message: "not a GitHub repository reference",
    });
  });
  test("429 says to try again in a minute", () => {
    expect(mapResponse(429, { error: "too many requests" }, URL_IN)).toEqual({
      kind: "rate_limited",
      message: "Try again in a minute",
    });
  });
  test("200 cached links to the review page", () => {
    expect(mapResponse(200, { cached: true, path: "x" }, `${URL_IN}.git`)).toEqual({
      kind: "cached",
      href: "/r/octo/cat",
      label: "octo/cat",
    });
  });
  test("202 queued gives the CLI command and claims no review", () => {
    expect(mapResponse(202, { queued: true }, `${URL_IN}/`)).toEqual({
      kind: "queued",
      command: "bun src/cli.ts review https://github.com/octo/cat --observational",
    });
  });
  test("unexpected statuses are an error, never a review", () => {
    expect(mapResponse(500, null, URL_IN).kind).toBe("error");
    expect(mapResponse(200, {}, URL_IN).kind).toBe("error");
  });
});

describe("repoFromInput", () => {
  test("accepts URL and bare forms, rejects others", () => {
    expect(repoFromInput("octo/cat")).toEqual({ owner: "octo", repo: "cat" });
    expect(repoFromInput("https://gitlab.com/octo/cat")).toBeNull();
  });
});
