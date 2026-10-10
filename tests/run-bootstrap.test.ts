// T49: `roster run` finds (or first writes) the review under the repo's slug, prices DeepSeek calls,
// and survives a failed trace flush.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { bootstrapReview, scorecardAt } from "../src/cli/run.ts";
import { defaultBackend } from "../src/agent/tools.ts";
import { deepseekClient, type RawCompletion, toResult } from "../src/llm/client.ts";
import { flushObs, flushWithRetry } from "../src/obs/index.ts";
import type { Review } from "../src/types.ts";

const MAKE_FIXTURE = join(import.meta.dir, "fixtures", "make-fixture.ts");
const SAVED_KEY = process.env.NEATLOGS_API_KEY;

let work: string;
let fixtureRepo: string;
let reportsDir: string;
let cacheDir: string;
const quiet = () => {};

beforeAll(() => {
  // runReview starts neatlogs; no test sends a trace.
  process.env.NEATLOGS_API_KEY = "";
  work = mkdtempSync(join(tmpdir(), "roster-run-bootstrap-"));
  // Built by the fixture script from the redacted samples; never hand-written.
  fixtureRepo = join(work, "fixture");
  const built = Bun.spawnSync([process.execPath, MAKE_FIXTURE, fixtureRepo, "--scenario", "basic"], { stdout: "pipe", stderr: "pipe" });
  if (built.exitCode !== 0) throw new Error(`make-fixture failed: ${built.stderr.toString()}`);
  reportsDir = join(work, "reports");
  cacheDir = join(work, "cache");
}, 120_000);

afterAll(() => {
  if (SAVED_KEY === undefined) delete process.env.NEATLOGS_API_KEY;
  else process.env.NEATLOGS_API_KEY = SAVED_KEY;
  if (work) rmSync(work, { recursive: true, force: true });
});

describe("bootstrap", () => {
  test("a missing review is written under the repo's slug, and get_scorecard reads it", async () => {
    const boot = await bootstrapReview(fixtureRepo, { cacheDir, reportsDir, log: quiet });
    // The fixture has no origin remote, so the slug is its basename, as `roster review` names it.
    expect(boot.slug).toBe(basename(fixtureRepo));
    expect(boot.reviewDir).toBe(join(reportsDir, "fixture"));
    expect(boot.reviewed).toBe(true);
    expect(existsSync(join(boot.reviewDir, "review.json"))).toBe(true);

    const backend = scorecardAt(defaultBackend({ cacheDir, reportsDir }), boot.reviewDir);
    const card = (await backend.getScorecard({ repo: "." })) as { review: Review; setups: unknown[] };
    expect(card.review.repo).toBe(boot.slug);
    expect(card.setups.length).toBeGreaterThan(0);
  }, 120_000);

  test("a current review is reused, not rewritten", async () => {
    let calls = 0;
    const boot = await bootstrapReview(fixtureRepo, {
      cacheDir,
      reportsDir,
      log: quiet,
      review: async () => ++calls,
    });
    expect(boot.reviewed).toBe(false);
    expect(calls).toBe(0);
  }, 60_000);

  test("a review older than the newest checkpoint is rerun", async () => {
    const path = join(reportsDir, "fixture", "review.json");
    const review = JSON.parse(readFileSync(path, "utf8")) as Review;
    writeFileSync(path, JSON.stringify({ ...review, generated_at: "2020-01-01T00:00:00.000Z" }));
    const ran: string[] = [];
    const boot = await bootstrapReview(fixtureRepo, {
      cacheDir,
      reportsDir,
      log: quiet,
      review: async (_repo, out) => {
        ran.push(out);
        return 0;
      },
    });
    expect(ran).toEqual([join(reportsDir, "fixture")]);
    expect(boot.reviewed).toBe(true);
  }, 60_000);

  test("with no review, get_scorecard says where it looked", async () => {
    const backend = scorecardAt(defaultBackend({ cacheDir, reportsDir }), join(work, "nowhere"));
    await expect(backend.getScorecard({ repo: "." })).rejects.toThrow(/no review in .*nowhere/);
  });
});

describe("DeepSeek pricing", () => {
  // A usage block in the chat-completions shape the client reads; a shape stub, not a recorded payload.
  const completion: RawCompletion = {
    model: "deepseek-flash",
    choices: [{ message: { content: "ok" } }],
    usage: { prompt_tokens: 1_000_000, completion_tokens: 100_000, prompt_cache_hit_tokens: 400_000, prompt_cache_miss_tokens: 600_000 },
  };
  // Peak: Monday 02:00 UTC. Off-peak: Saturday.
  const PEAK = new Date("2026-10-12T02:00:00Z");
  const OFF_PEAK = new Date("2026-10-10T02:00:00Z");

  test("cache miss, cache hit and output tokens price at the peak rows", () => {
    // 0.6M × $0.30 + 0.4M × $0.006 + 0.1M × $1.20
    expect(toResult(completion, PEAK).costUsd).toBeCloseTo(0.18 + 0.0024 + 0.12, 10);
  });

  test("off-peak is half", () => {
    expect(toResult(completion, OFF_PEAK).costUsd).toBeCloseTo((0.18 + 0.0024 + 0.12) / 2, 10);
  });

  test("an answering model name with no row falls back to the requested model", () => {
    expect(toResult({ ...completion, model: "deepseek-flash-2026" }, PEAK, "deepseek-flash").costUsd).toBeCloseTo(0.3024, 10);
    expect(toResult({ ...completion, model: "mystery" }, PEAK).costUsd).toBeNull();
  });

  test("the client prices every call at its clock", async () => {
    const client = deepseekClient({ transport: async () => completion, now: () => PEAK });
    const res = await client.chat({ messages: [{ role: "user", content: "hi" }], model: "deepseek-flash" });
    expect(res.costUsd).toBeCloseTo(0.3024, 10);
  });
});

describe("flush", () => {
  test("a throwing flush is retried once, logs one line and resolves false", async () => {
    const lines: string[] = [];
    let calls = 0;
    const ok = await flushWithRetry(
      async () => {
        calls++;
        throw new Error("network down");
      },
      { log: (m) => lines.push(m) },
    );
    expect(ok).toBe(false);
    expect(calls).toBe(2);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("network down");
  });

  test("a hung flush times out instead of blocking exit", async () => {
    const lines: string[] = [];
    const ok = await flushWithRetry(() => new Promise(() => {}), { timeoutMs: 20, log: (m) => lines.push(m) });
    expect(ok).toBe(false);
    expect(lines[0]).toContain("timed out");
  });

  test("a retry that succeeds logs nothing", async () => {
    const lines: string[] = [];
    let calls = 0;
    const ok = await flushWithRetry(async () => ++calls > 1, { log: (m) => lines.push(m) });
    expect(ok).toBe(true);
    expect(lines).toHaveLength(0);
  });

  test("flushObs with tracing off resolves true", async () => {
    expect(await flushObs()).toBe(true);
  });
});
