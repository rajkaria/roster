import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { identify } from "../src/identity/index.ts";
import { parseCheckpoints } from "../src/ingest/parse.ts";
import { aggregateBySetup, scoreSessions } from "../src/score/index.ts";
import type { Session } from "../src/types.ts";
import { git, makeFixture, type FixtureTruth } from "./fixtures/make-fixture.ts";

setDefaultTimeout(60_000);

const root = mkdtempSync(join(tmpdir(), "roster-unattended-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let dir: string;
let truth: FixtureTruth;
let copies = 0;

function load(repo: string): Session[] {
  return parseCheckpoints(repo, "branch", { warn: () => {} }).map((s) => ({ ...s, setup_id: identify(s, repo).setupId }));
}

beforeAll(() => {
  dir = join(root, "multisession");
  truth = makeFixture(dir, "multisession");
});

describe("unattended does not depend on maturity", () => {
  // HEAD reset to the "add delta" commit: nothing is newer than it, so its sessions are too_young.
  function young(prompts: number): { repo: string; session: Session } {
    const sha = truth.commits.find((c) => c.subject === "add delta")!.sha;
    const repo = join(root, `young-${copies++}`);
    git(root, ["clone", "-q", "--no-local", dir, repo]);
    git(repo, ["fetch", "-q", "origin", "entire/checkpoints/v1:entire/checkpoints/v1"]);
    git(repo, ["reset", "-q", "--hard", sha]);
    const session = load(repo).find((x) => x.commit_sha === sha)!;
    return { repo, session: { ...session, n_user_prompts: prompts } };
  }

  test("a too_young one-prompt session is unattended with null survival", () => {
    const { repo, session } = young(1);
    const [o] = scoreSessions(repo, [session]);
    expect(o).toMatchObject({ status: "too_young", censored: "too_young", unattended: true, survival: null, reverted: null, rework_human: null, rework_agent: null });
  });

  test("a too_young multi-prompt session is not unattended", () => {
    const { repo, session } = young(3);
    expect(scoreSessions(repo, [session])[0]!.unattended).toBe(false);
  });

  test("setup unattended share counts too_young sessions", () => {
    const { repo, session } = young(1);
    const [agg] = aggregateBySetup(scoreSessions(repo, [session]));
    expect(agg).toMatchObject({ mature: 0, too_young: 1, unattended: 1 });
  });
});
