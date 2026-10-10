import { expect, test } from "bun:test";
import { runBookCommand } from "../../../src/cli/book.ts";

const review = {
  id: "rev_123",
  repo: "owner/repo",
  created_at: "2020-01-02T03:04:05.000Z",
  generated_at: "2020-02-03T04:05:06.000Z",
  has_entire_data: true,
  setups: [
    {
      setup_id: "setup_1",
      label: "setup",
      harness: "harness",
      model: "model",
      rules_hash: null,
      sessions: 10,
      mature_sessions: 10,
      spend_usd: 100,
      unattended: 0.5,
      survival: 0.5,
      reverted: 0.1,
      rework_human: 0.2,
      surviving_changes: 5,
      cost_per_surviving_change: 20,
      evidence_level: "A",
    },
  ],
  label: "no_suspect",
  suspect: null,
  odds_ratio: null,
  ci95: null,
  p_value: null,
  evidence_level: "A",
};

test("missing --review prints usage and returns 2", async () => {
  let stdout = "";
  const deps = {
    readJson: async () => review,
    stdout: (s: string) => {
      stdout += s;
    },
  };

  const result = await runBookCommand([], deps);

  expect(result).toBe(2);
  expect(stdout).toMatch(/usage/i);
});

test("without --write prints book JSON and returns 0 using defaults", async () => {
  let stdout = "";
  let readPath = "";
  const deps = {
    readJson: async (path: string) => {
      readPath = path;
      return review;
    },
    stdout: (s: string) => {
      stdout += s;
    },
  };

  const result = await runBookCommand(["--review", "review.json"], deps);

  expect(result).toBe(0);
  expect(readPath).toBe("review.json");
  expect(stdout).toContain("15000");
  expect(stdout).toContain("50");
  expect(stdout).toContain(review.created_at);
  expect(stdout).toContain(review.generated_at);
  expect(() => JSON.parse(stdout)).not.toThrow();
});

test("uses provided engineer and scale session values", async () => {
  let stdout = "";
  const deps = {
    readJson: async () => review,
    stdout: (s: string) => {
      stdout += s;
    },
  };

  const result = await runBookCommand([
    "--review",
    "review.json",
    "--engineer-usd",
    "123456",
    "--scale-sessions",
    "777",
  ], deps);

  expect(result).toBe(0);
  expect(stdout).toContain("123456");
  expect(stdout).toContain("777");
});

test("with --write and ok true returns 0 and calls writeBook", async () => {
  let stdout = "";
  let readPath = "";
  let writtenBook: unknown;
  const deps = {
    readJson: async (path: string) => {
      readPath = path;
      return review;
    },
    writeBook: async (book: unknown) => {
      writtenBook = book;
      return { ok: true };
    },
    stdout: (s: string) => {
      stdout += s;
    },
  };

  const result = await runBookCommand(["--review", "review.json", "--write"], deps);

  expect(result).toBe(0);
  expect(readPath).toBe("review.json");
  expect(writtenBook).toBeDefined();
  expect(stdout).toBe("");
});

test("with --write and ok false returns 1", async () => {
  let stdout = "";
  const deps = {
    readJson: async () => review,
    writeBook: async () => ({ ok: false }),
    stdout: (s: string) => {
      stdout += s;
    },
  };

  const result = await runBookCommand(["--review", "review.json", "--write"], deps);

  expect(result).toBe(1);
});
