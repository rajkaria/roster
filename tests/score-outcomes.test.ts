import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { identify } from "../src/identity/index.ts";
import { parseCheckpoints } from "../src/ingest/parse.ts";
import { priceSession } from "../src/price/index.ts";
import {
  aggregateBySetup,
  maturity,
  outcomesReport,
  scoreSessions,
  UNKNOWN_SETUP,
  type ScoredOutcome,
} from "../src/score/index.ts";
import type { Session } from "../src/types.ts";
import { checkReport, sumcheck } from "../scripts/sumcheck.ts";
import { git, makeFixture, type FixtureTruth } from "./fixtures/make-fixture.ts";

// Building a fixture and scoring it spawns git a few hundred times.
setDefaultTimeout(60_000);

const root = mkdtempSync(join(tmpdir(), "roster-score-outcomes-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let dir: string;
let truth: FixtureTruth;
let sessions: Session[];
/** Fixture setup key (from the prompt tag) → inferred setup id. */
const setupOf: Record<string, string> = {};

function load(repo: string): Session[] {
  return parseCheckpoints(repo, "branch", { warn: () => {} }).map((s) => {
    const id = identify(s, repo);
    if (id.tag && id.setupId) setupOf[id.tag.setup] = id.setupId;
    return { ...s, setup_id: id.setupId };
  });
}

const sha = (subject: string) => {
  const c = truth.commits.find((x) => x.subject === subject);
  if (!c) throw new Error(`no fixture commit "${subject}"`);
  return c.sha;
};
/** A copy of the fixture whose HEAD is reset to `subject`, to see the repo as it was then. */
let copies = 0;
function copyAt(subject: string): string {
  const d = join(root, `copy-${copies++}`);
  git(root, ["clone", "-q", "--no-local", dir, d]);
  git(d, ["fetch", "-q", "origin", "entire/checkpoints/v1:entire/checkpoints/v1"]);
  git(d, ["reset", "-q", "--hard", sha(subject)]);
  return d;
}
const byCommit = (rows: ScoredOutcome[], subject: string) => rows.filter((o) => o.commit_sha === sha(subject));

beforeAll(() => {
  dir = join(root, "multisession");
  truth = makeFixture(dir, "multisession");
  sessions = load(dir);
});

describe("scoreSessions on the multisession fixture", () => {
  let rows: ScoredOutcome[];
  beforeAll(() => {
    rows = scoreSessions(dir, sessions);
  });

  test("one row per session", () => {
    expect(rows.map((o) => o.session_id).sort()).toEqual(sessions.map((s) => s.id).sort());
  });

  test("expected table", () => {
    const table = rows
      .map((o) => ({
        commit: truth.commits.find((c) => c.sha === o.commit_sha)?.subject ?? null,
        setup: Object.keys(setupOf).find((k) => setupOf[k] === o.setup_id) ?? null,
        status: o.status,
        censored: o.censored,
        survival: o.survival === null ? null : Math.round(o.survival * 1000) / 1000,
        reverted: o.reverted,
        rework_human: o.rework_human === null ? null : Math.round(o.rework_human * 1000) / 1000,
        rework_agent: o.rework_agent,
        unattended: o.unattended,
      }))
      .sort((a, b) => `${a.commit}${a.setup}`.localeCompare(`${b.commit}${b.setup}`));
    expect(table).toEqual([
      // alpha: 10 of 30 lines rewritten by a human; the session took three prompts over three commits.
      { commit: "add alpha", setup: "X", status: "mature", censored: null, survival: 0.667, reverted: false, rework_human: 0.333, rework_agent: 0, unattended: false },
      { commit: "add beta", setup: "Y", status: "mature", censored: null, survival: 1, reverted: false, rework_human: 0, rework_agent: 0, unattended: false },
      { commit: "add delta", setup: "Y", status: "mature", censored: null, survival: 1, reverted: false, rework_human: 0, rework_agent: 0, unattended: true },
      { commit: "add delta", setup: "Z", status: "mature", censored: null, survival: 1, reverted: false, rework_human: 0, rework_agent: 0, unattended: true },
      // gamma: reverted by a human commit, which also counts as human rework of every line.
      { commit: "add gamma", setup: "Z", status: "mature", censored: null, survival: 0, reverted: true, rework_human: 1, rework_agent: 0, unattended: true },
      // The orphan checkpoint has no commit: kept, with no metrics.
      { commit: null, setup: "Y", status: "too_young", censored: "no_commit", survival: null, reverted: null, rework_human: null, rework_agent: null, unattended: null },
    ]);
  });

  test("cost comes from src/price; an unknown model gives null", () => {
    for (const s of sessions) {
      const o = rows.find((r) => r.session_id === s.id)!;
      const expected = priceSession(s.model, {
        input: s.tokens_in,
        output: s.tokens_out,
        cache_read: s.cache_read,
        cache_write: s.cache_write,
      }).usd;
      expect(o.cost_usd).toBe(expected);
    }
    expect(rows.every((o) => typeof o.cost_usd === "number" && o.cost_usd > 0)).toBe(true);
    const unknown = { ...sessions[0]!, model: "unknown" };
    expect(scoreSessions(dir, [unknown])[0]!.cost_usd).toBeNull();
  });

  test("a session's own cost_usd wins over re-pricing", () => {
    const s = { ...sessions.find((x) => x.commit_sha === null)!, cost_usd: 1.25 };
    expect(scoreSessions(dir, [s])[0]!.cost_usd).toBe(1.25);
  });
});

describe("maturity censoring", () => {
  test("commits with fewer than 5 first-parent commits after them are too_young with null metrics", () => {
    // HEAD at the human rework: delta has 1 commit after it, alpha has 5.
    const d = copyAt("human: rework src/alpha.ts");
    const rows = scoreSessions(d, load(d));
    for (const o of byCommit(rows, "add delta")) {
      expect(o).toMatchObject({ status: "too_young", censored: "too_young", survival: null, reverted: null, rework_human: null, rework_agent: null, unattended: null });
      expect(o.cost_usd).toBe(rows.find((r) => r.session_id === o.session_id)!.cost_usd);
    }
    expect(byCommit(rows, "add alpha")[0]!.status).toBe("mature");
    expect(byCommit(rows, "add gamma")[0]!.status).toBe("too_young"); // 2 after it
  });

  test("5 newer commits are not enough when HEAD is under 6 h younger", () => {
    const d = copyAt("add epsilon");
    const epsilonAt = Date.parse(truth.commits.find((c) => c.subject === "add epsilon")!.date);
    const commitAt = (offsetH: number, i: number) => {
      writeFileSync(join(d, `late-${i}.md`), `${i}\n`);
      git(d, ["add", "-A"]);
      const at = new Date(epsilonAt + offsetH * 3600 * 1000).toISOString();
      git(d, ["commit", "-q", "--no-gpg-sign", "-m", `late ${i}`], { env: { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });
    };
    for (let i = 0; i < 5; i++) commitAt(1, i);
    expect(maturity(d, sha("add epsilon"))).toBe("too_young");
    commitAt(5.99, 5);
    expect(maturity(d, sha("add epsilon"))).toBe("too_young");
    commitAt(6, 6);
    expect(maturity(d, sha("add epsilon"))).toBeNull();
  });

  test("a commit that HEAD does not contain is censored as not_on_head", () => {
    const d = copyAt("add beta");
    expect(maturity(d, sha("add delta"))).toBe("not_on_head");
  });
});

describe("aggregateBySetup", () => {
  let rows: ScoredOutcome[];
  beforeAll(() => {
    rows = scoreSessions(dir, sessions);
  });

  test("per-setup counts, survival and cost_per_surviving_change", () => {
    const agg = Object.fromEntries(aggregateBySetup(rows).map((a) => [a.setup_id, a]));
    const x = agg[setupOf.X!]!;
    const y = agg[setupOf.Y!]!;
    const z = agg[setupOf.Z!]!;
    expect([x.sessions, x.mature, x.too_young, x.reverted, x.unattended]).toEqual([1, 1, 0, 0, 0]);
    expect([y.sessions, y.mature, y.too_young, y.reverted, y.unattended]).toEqual([3, 2, 1, 0, 1]);
    expect([z.sessions, z.mature, z.too_young, z.reverted, z.unattended]).toEqual([2, 2, 0, 1, 2]);
    expect(x.survival_sum).toBeCloseTo(20 / 30, 10);
    expect(y.survival_mean).toBe(1);
    expect(z.survival_sum).toBe(1);

    const cost = (setup: string, mature: boolean) =>
      rows.filter((o) => o.setup_id === setup && (!mature || o.status === "mature")).reduce((a, o) => a + o.cost_usd!, 0);
    expect(x.cost_usd).toBeCloseTo(cost(setupOf.X!, false), 12);
    expect(x.cost_per_surviving_change).toBeCloseTo(cost(setupOf.X!, true) / (20 / 30), 12);
    // Y's orphan session costs money but is not mature: it counts in cost_usd, not in cost per surviving change.
    expect(y.cost_usd).toBeCloseTo(cost(setupOf.Y!, false), 12);
    expect(y.cost_per_surviving_change).toBeCloseTo(cost(setupOf.Y!, true) / 2, 12);
    expect(y.cost_usd!).toBeGreaterThan(cost(setupOf.Y!, true));
    // gamma survived 0 and delta 1: Z pays for both over one surviving change.
    expect(z.cost_per_surviving_change).toBeCloseTo(cost(setupOf.Z!, true), 12);
    expect(z.cost_unknown).toBe(0);
  });

  test("an unknown cost leaves the setup's cost per surviving change null, not a partial sum", () => {
    const zRows = rows.filter((o) => o.setup_id === setupOf.Z).map((o, i) => (i === 0 ? { ...o, cost_usd: null } : o));
    const [z] = aggregateBySetup(zRows);
    expect(z!.cost_unknown).toBe(1);
    expect(z!.cost_usd).toBeNull();
    expect(z!.cost_per_surviving_change).toBeNull();
  });

  test("sessions without a setup go to the unknown bucket; zero survival gives null cost per change", () => {
    const o: ScoredOutcome = { ...rows.find((r) => r.reverted)!, setup_id: null, cost_usd: 2 };
    const [a] = aggregateBySetup([o]);
    expect(a!.setup_id).toBe(UNKNOWN_SETUP);
    expect(a!.cost_usd).toBe(2);
    expect(a!.cost_per_surviving_change).toBeNull();
  });

  test("the exported report passes scripts/sumcheck.ts", () => {
    const report = outcomesReport(rows);
    expect(report.sessions.total).toBe(6);
    expect(report.mature.total).toBe(5);
    expect(report.too_young.total).toBe(1);
    expect(Object.keys(report.cost_by_setup).sort()).toEqual([setupOf.X!, setupOf.Y!, setupOf.Z!].sort());
    const reports = join(root, "reports");
    mkdirSync(reports, { recursive: true });
    writeFileSync(join(reports, "outcomes.json"), JSON.stringify(report, null, 2));
    expect(sumcheck(reports)).toEqual({ files: 1, mismatches: [] });

    // Sanity: the check does bite on this shape.
    const broken = { ...report, cost_total_usd: report.cost_total_usd + 1 };
    expect(checkReport("outcomes.json", broken).length).toBe(1);
  });
});
