import { expect, test } from "bun:test";
import { isAllowed, loadOptIns } from "../src/review/opt-in";

const opt = loadOptIns([
  { repo: "Acme/Widget", public: true, prAllowed: false, replyUrl: "https://acme.dev/hook" },
  { repo: "acme/pr", public: false, prAllowed: true, replyUrl: "http://insecure" },
  { repo: "bad", public: true, prAllowed: true },
  { repo: "x/y", public: "yes", prAllowed: true },
  null,
]);

test("malformed dropped, replyUrl https only", () => {
  expect(opt.map((o) => o.repo)).toEqual(["Acme/Widget", "acme/pr"]);
  expect(opt[0]?.replyUrl).toBe("https://acme.dev/hook");
  expect(opt[1]?.replyUrl).toBeUndefined();
});

test("non-array input yields empty", () => {
  expect(loadOptIns({})).toEqual([]);
});

test("actions gated per flag, case-insensitive", () => {
  expect(isAllowed(opt, "ACME/widget", "review-public")).toBe(true);
  expect(isAllowed(opt, "acme/widget", "open-pr")).toBe(false);
  expect(isAllowed(opt, "acme/pr", "open-pr")).toBe(true);
  expect(isAllowed(opt, "acme/pr", "review-public")).toBe(false);
});

test("unknown repo denied", () => {
  expect(isAllowed(opt, "other/repo", "review-public")).toBe(false);
  expect(isAllowed(opt, "other/repo", "open-pr")).toBe(false);
});
