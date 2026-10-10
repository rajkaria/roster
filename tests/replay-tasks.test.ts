import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { identify } from "../src/identity/index.ts";
import { parseCheckpoints } from "../src/ingest/parse.ts";
import { buildReplayTasks, planReplayTasks, stripTag } from "../src/replay/tasks.ts";
import type { Session } from "../src/types.ts";
import { git, makeFixture, type FixtureTruth } from "./fixtures/make-fixture.ts";

setDefaultTimeout(60_000);

const root = mkdtempSync(join(tmpdir(), "roster-replay-tasks-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let dir: string;
let truth: FixtureTruth;
let sessions: Session[];
let testSha: string;

const commitOf = (subject: string) => {
  const c = truth.commits.find((x) => x.subject === subject);
  if (!c) throw new Error(`no fixture commit "${subject}"`);
  return c;
};
const byTag = (task: string) => {
  const s = sessions.find((x) => x.first_prompt.includes(`task=${task}]`));
  if (!s) throw new Error(`no session tagged ${task}`);
  return s;
};

beforeAll(() => {
  dir = join(root, "repo");
  truth = makeFixture(dir, "multisession");
  // The team kept a test with the gamma change: a later commit that carries gamma's checkpoint.
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "tests", "gamma.test.ts"), "// kept test\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", `gamma tests\n\nEntire-Checkpoint: ${commitOf("add gamma").checkpoint_id}\n`], {
    env: { GIT_AUTHOR_DATE: "2026-10-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-01T00:00:00Z" },
  });
  testSha = git(dir, ["rev-parse", "HEAD"]);
  sessions = parseCheckpoints(dir, "branch", { warn: () => {} }).map((s) => ({
    ...s,
    setup_id: identify(s, dir).setupId,
  }));
});

describe("buildReplayTasks", () => {
  test("strips the roster tag line from the prompt and keeps it in tag", () => {
    const t = buildReplayTasks(dir, sessions, []).find((x) => x.sessionId === byTag("y2").id)!;
    expect(t.prompt).toBe("Add tests for delta.");
    expect(t.tag).toBe("roster setup=Y task=y2");
    expect(stripTag("[roster setup=X task=a]\nDo it").prompt).toBe("Do it");
    expect(stripTag("No tag here")).toEqual({ tag: null, prompt: "No tag here" });
  });

  test("two-commit session: parent of the earliest, latest as original", () => {
    const t = buildReplayTasks(dir, sessions, []).find((x) => x.sessionId === byTag("z1").id)!;
    expect(t.parentSha).toBe(git(dir, ["rev-parse", `${commitOf("add gamma").sha}^1`]));
    expect(t.originalSha).toBe(testSha);
    expect(t.hiddenTests.map((h) => h.path)).toEqual(["tests/gamma.test.ts"]);
    expect(t.track).toBe("tests");
  });

  test("a session with no tests is judge-only", () => {
    const t = buildReplayTasks(dir, sessions, []).find((x) => x.sessionId === byTag("y2").id)!;
    expect(t.hiddenTests).toEqual([]);
    expect(t.track).toBe("judge-only");
  });

  test("more than two prompts gives track none", () => {
    const t = buildReplayTasks(dir, sessions, []).find((x) => x.sessionId === byTag("x1").id)!;
    expect(t.userPrompts).toBeGreaterThan(2);
    expect(t.track).toBe("none");
    expect(t.originalSha).toBe(commitOf("add epsilon").sha);
    expect(t.parentSha).toBe(git(dir, ["rev-parse", `${commitOf("add alpha").sha}^1`]));
  });

  test("sessions without a commit are skipped with a reason; order follows the original commit", () => {
    const { tasks, skipped } = planReplayTasks(dir, sessions, []);
    expect(skipped).toEqual([{ sessionId: byTag("y3").id, reason: "no linked commit" }]);
    expect(tasks.some((t) => t.sessionId === byTag("y3").id)).toBe(false);
    const times = tasks.map((t) => Number(git(dir, ["show", "-s", "--format=%ct", t.originalSha])));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(planReplayTasks(dir, [...sessions].reverse(), []).tasks.map((t) => t.id)).toEqual(tasks.map((t) => t.id));
  });

  test("tercile comes from the outcome", () => {
    const s = byTag("y2");
    const out = { session_id: s.id, status: "mature", tercile: 2 } as never;
    expect(buildReplayTasks(dir, sessions, [out]).find((t) => t.sessionId === s.id)!.tercile).toBe(2);
  });
});
