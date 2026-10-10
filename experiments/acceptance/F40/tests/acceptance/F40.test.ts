import { describe, expect, test } from "bun:test";
import { isAllowed, loadOptIns } from "../../src/review/opt-in.ts";

describe("loadOptIns", () => {
  test("drops malformed entries", () => {
    const parsed = loadOptIns([
      { repo: "Good/Owner", public: true, prAllowed: false },
      null,
      42,
      {},
      { repo: "MissingPublic/Owner", prAllowed: true },
      { repo: "MissingPr/Owner", public: true },
      { repo: "BadPublic/Owner", public: "true", prAllowed: false },
      { repo: "BadPr/Owner", public: true, prAllowed: "true" },
    ]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].repo).toMatch(/^Good\/Owner$/i);
    expect(parsed[0].public).toBe(true);
    expect(parsed[0].prAllowed).toBe(false);
  });

  test("keeps replyUrl only when it is an https URL", () => {
    const [withHttps] = loadOptIns([
      { repo: "A/B", public: true, prAllowed: true, replyUrl: "https://example.com/hook" },
    ]);
    expect(withHttps.replyUrl).toBe("https://example.com/hook");

    const [withHttp] = loadOptIns([
      { repo: "C/D", public: true, prAllowed: true, replyUrl: "http://example.com/hook" },
    ]);
    expect(withHttp.replyUrl).toBeUndefined();

    const [withFtp] = loadOptIns([
      { repo: "E/F", public: true, prAllowed: true, replyUrl: "ftp://example.com/hook" },
    ]);
    expect(withFtp.replyUrl).toBeUndefined();
  });
});

describe("isAllowed", () => {
  const optIns = loadOptIns([
    { repo: "Some/Repo", public: true, prAllowed: true },
    { repo: "PublicOnly/Repo", public: true, prAllowed: false },
    { repo: "PrOnly/Repo", public: false, prAllowed: true },
  ]);

  test("denies unknown repos for every action", () => {
    expect(isAllowed(optIns, "Unknown/Repo", "review-public")).toBe(false);
    expect(isAllowed(optIns, "Unknown/Repo", "open-pr")).toBe(false);
    expect(isAllowed(optIns, "Some/Repo2", "review-public")).toBe(false);
  });

  test("compares repo names case-insensitively", () => {
    expect(isAllowed(optIns, "some/repo", "review-public")).toBe(true);
    expect(isAllowed(optIns, "SOME/REPO", "open-pr")).toBe(true);
    expect(isAllowed(optIns, "Some/Repo", "review-public")).toBe(true);
  });

  test("review-public requires public true", () => {
    expect(isAllowed(optIns, "PublicOnly/Repo", "review-public")).toBe(true);
    expect(isAllowed(optIns, "publiconly/repo", "review-public")).toBe(true);
    expect(isAllowed(optIns, "PrOnly/Repo", "review-public")).toBe(false);
  });

  test("open-pr requires prAllowed true", () => {
    expect(isAllowed(optIns, "PrOnly/Repo", "open-pr")).toBe(true);
    expect(isAllowed(optIns, "pronly/repo", "open-pr")).toBe(true);
    expect(isAllowed(optIns, "PublicOnly/Repo", "open-pr")).toBe(false);
  });

  test("allows both actions when both flags are true", () => {
    expect(isAllowed(optIns, "Some/Repo", "review-public")).toBe(true);
    expect(isAllowed(optIns, "Some/Repo", "open-pr")).toBe(true);
  });
});
