import { describe, test, expect } from "bun:test";
import { attributeCommit } from "../../src/attribution/line.ts";

describe("attributeCommit", () => {
  test("one session with no humanAdded attributes every line to that session", () => {
    const result = attributeCommit({
      commit: "abc123",
      addedLines: [
        { file: "src/a.ts", line: 1 },
        { file: "src/a.ts", line: 2 },
        { file: "src/b.ts", line: 5 },
      ],
      sessions: [
        {
          sessionId: "s1",
          filesTouched: ["src/a.ts", "src/b.ts"],
          agentLines: 3,
        },
      ],
    });

    expect(result).toEqual([
      { file: "src/a.ts", line: 1, sessionId: "s1" },
      { file: "src/a.ts", line: 2, sessionId: "s1" },
      { file: "src/b.ts", line: 5, sessionId: "s1" },
    ]);
  });

  test("one session with humanAdded marks the last humanAdded lines in file order as human", () => {
    const result = attributeCommit({
      commit: "abc123",
      addedLines: [
        { file: "b.ts", line: 1 },
        { file: "a.ts", line: 2 },
        { file: "a.ts", line: 1 },
        { file: "b.ts", line: 2 },
      ],
      sessions: [
        {
          sessionId: "s1",
          filesTouched: ["a.ts", "b.ts"],
          agentLines: 4,
          humanAdded: 2,
        },
      ],
    });

    expect(result).toEqual([
      { file: "b.ts", line: 1, sessionId: "human" },
      { file: "a.ts", line: 2, sessionId: "s1" },
      { file: "a.ts", line: 1, sessionId: "s1" },
      { file: "b.ts", line: 2, sessionId: "human" },
    ]);
  });

  test("humanAdded respects file and line order, not input order", () => {
    const result = attributeCommit({
      commit: "abc123",
      addedLines: [
        { file: "a.ts", line: 10 },
        { file: "a.ts", line: 1 },
        { file: "a.ts", line: 5 },
      ],
      sessions: [
        {
          sessionId: "s1",
          filesTouched: ["a.ts"],
          agentLines: 3,
          humanAdded: 1,
        },
      ],
    });

    expect(result).toEqual([
      { file: "a.ts", line: 10, sessionId: "human" },
      { file: "a.ts", line: 1, sessionId: "s1" },
      { file: "a.ts", line: 5, sessionId: "s1" },
    ]);
  });

  test("several sessions attributes a line to the only session that touched its file", () => {
    const result = attributeCommit({
      commit: "abc123",
      addedLines: [
        { file: "a.ts", line: 1 },
        { file: "b.ts", line: 2 },
        { file: "c.ts", line: 3 },
      ],
      sessions: [
        { sessionId: "s1", filesTouched: ["a.ts"], agentLines: 10 },
        { sessionId: "s2", filesTouched: ["b.ts"], agentLines: 10 },
      ],
    });

    expect(result).toEqual([
      { file: "a.ts", line: 1, sessionId: "s1" },
      { file: "b.ts", line: 2, sessionId: "s2" },
      { file: "c.ts", line: 3, sessionId: "unknown" },
    ]);
  });

  test("when several sessions touched a file, picks the first with largest agentLines", () => {
    const result = attributeCommit({
      commit: "abc123",
      addedLines: [{ file: "shared.ts", line: 7 }],
      sessions: [
        { sessionId: "s1", filesTouched: ["shared.ts"], agentLines: 5 },
        { sessionId: "s2", filesTouched: ["shared.ts"], agentLines: 12 },
        { sessionId: "s3", filesTouched: ["shared.ts"], agentLines: 12 },
        { sessionId: "s4", filesTouched: ["other.ts"], agentLines: 13 },
      ],
    });

    expect(result).toEqual([
      { file: "shared.ts", line: 7, sessionId: "s2" },
    ]);
  });

  test("largest agentLines tie uses the earliest listed session", () => {
    const result = attributeCommit({
      commit: "abc123",
      addedLines: [{ file: "shared.ts", line: 1 }],
      sessions: [
        { sessionId: "s1", filesTouched: ["shared.ts"], agentLines: 9 },
        { sessionId: "s2", filesTouched: ["shared.ts"], agentLines: 9 },
      ],
    });

    expect(result).toEqual([
      { file: "shared.ts", line: 1, sessionId: "s1" },
    ]);
  });

  test("humanAdded is only applied when there is exactly one session", () => {
    const result = attributeCommit({
      commit: "abc123",
      addedLines: [{ file: "a.ts", line: 1 }],
      sessions: [
        {
          sessionId: "s1",
          filesTouched: ["a.ts"],
          agentLines: 1,
          humanAdded: 1,
        },
        {
          sessionId: "s2",
          filesTouched: ["b.ts"],
          agentLines: 1,
          humanAdded: 0,
        },
      ],
    });

    expect(result).toEqual([
      { file: "a.ts", line: 1, sessionId: "s1" },
    ]);
  });
});
