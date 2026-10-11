import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { priceResultEvent } from "../src/harness/claude.ts";
import { lastResultEvent, priceRunLog, repricePairs, runLogPath, writeRepriced } from "../src/forward/cost.ts";
import { ForwardStore } from "../src/forward/index.ts";
import { priceDeepSeek } from "../src/price/deepseek.ts";

// Real result events from F01 (the E and B runs), copied verbatim from .roster/runs.
const FIXTURES = join(import.meta.dir, "fixtures", "forward-cost");
const E_LINE = readFileSync(join(FIXTURES, "F01.E.result.jsonl"), "utf8");
const B_LINE = readFileSync(join(FIXTURES, "F01.B.result.jsonl"), "utf8");
const E = JSON.parse(E_LINE);
const B = JSON.parse(B_LINE);

// Monday 2026-10-12, 02:00 UTC is DeepSeek peak; 05:00 UTC is off-peak.
const PEAK = new Date("2026-10-12T02:00:00.000Z");
const OFF_PEAK = new Date("2026-10-12T05:00:00.000Z");

// E's modelUsage: deepseek-flash, 30054 input, 11856 output, 537472 cache read, 0 cache write.
const E_TOKENS = { input: 30054, output: 11856, cache_read: 537472, cache_write: 0 };
const E_PEAK_USD = 0.3 * 0.030054 + 1.2 * 0.011856 + 0.006 * 0.537472; // 0.026468232
const B_USD = 0.1982497; // B's total_cost_usd, the Claude price the replay path keeps

const tmp = () => mkdtempSync(join(tmpdir(), "forward-cost-"));

describe("priceResultEvent", () => {
  test("E (DeepSeek through Claude Code) is priced from its tokens, not total_cost_usd", () => {
    const r = priceResultEvent(E, null, PEAK);
    expect(r.basis).toBe("deepseek-tokens");
    expect(r.model).toBe("deepseek-flash");
    expect(r.usd).toBeCloseTo(E_PEAK_USD, 12);
    expect(r.usd).toBeCloseTo(priceDeepSeek("deepseek-flash", E_TOKENS, PEAK)!.usd!, 12);
    expect(r.usd).not.toBeCloseTo(E.total_cost_usd, 2);
  });

  test("E off-peak is half the peak figure", () => {
    expect(priceResultEvent(E, null, OFF_PEAK).usd).toBeCloseTo(E_PEAK_USD / 2, 12);
  });

  test("B (Claude) keeps the replay path's figure: total_cost_usd", () => {
    const r = priceResultEvent(B, null, PEAK);
    expect(r).toEqual({ usd: B_USD, model: "claude-sonnet-5-5", basis: "total_cost_usd" });
  });

  test("a model that is neither DeepSeek nor Claude is null, never a guess", () => {
    const other = { ...E, modelUsage: { "gpt-6-astra": E.modelUsage["deepseek-flash"] } };
    expect(priceResultEvent(other, null, PEAK)).toEqual({ usd: null, model: "gpt-6-astra", basis: null });
  });

  test("no result event is null", () => {
    expect(priceResultEvent(null, null, PEAK)).toEqual({ usd: null, model: null, basis: null });
  });

  test("the fallback model names the run when modelUsage is absent", () => {
    const { modelUsage: _drop, ...noUsage } = B;
    expect(priceResultEvent(noUsage, "claude-sonnet-5-5", PEAK)).toEqual({ usd: B_USD, model: "claude-sonnet-5-5", basis: "total_cost_usd" });
  });
});

describe("priceRunLog and lastResultEvent", () => {
  test("a missing log is found: false with a null cost", () => {
    const r = priceRunLog(join(tmp(), "F01.E.jsonl"), PEAK);
    expect(r).toEqual({ usd: null, model: null, basis: null, found: false });
  });

  test("a log's last result event is the one priced", () => {
    const dir = tmp();
    const log = join(dir, "F01.E.jsonl");
    writeFileSync(log, [B_LINE, '{"type":"assistant","message":{}}\n', E_LINE].join(""));
    expect(lastResultEvent(log)?.session_id).toBe(E.session_id);
    expect(priceRunLog(log, PEAK)).toEqual({ ...priceResultEvent(E, null, PEAK), found: true });
  });

  test("a log with no result event is found: false", () => {
    const log = join(tmp(), "F01.E.jsonl");
    writeFileSync(log, '{"type":"assistant","message":{}}\n');
    expect(priceRunLog(log, PEAK).found).toBe(false);
  });
});

describe("repricePairs and writeRepriced", () => {
  const runs = () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(FIXTURES, "F01.E.result.jsonl"), runLogPath(dir, "F01", "E"));
    copyFileSync(join(FIXTURES, "F01.B.result.jsonl"), runLogPath(dir, "F01", "B"));
    return dir;
  };

  test("re-prices both sides and reports the stored costs before", () => {
    const [row] = repricePairs(
      [{ task_id: "F01", setup_old: "B", setup_new: "E", cost_old: 0.5, cost_new: E.total_cost_usd }],
      runs(),
      PEAK,
    );
    expect(row!.cost_old).toBe(B_USD);
    expect(row!.cost_new).toBeCloseTo(E_PEAK_USD, 12);
    expect(row!.before).toEqual({ cost_old: 0.5, cost_new: E.total_cost_usd });
    expect(row!.old.basis).toBe("total_cost_usd");
    expect(row!.new.basis).toBe("deepseek-tokens");
    expect(row!.missing).toEqual([]);
  });

  test("a pair with a missing log gets a null cost and the log is listed", () => {
    const dir = runs();
    const [row] = repricePairs([{ task_id: "T99", setup_old: "B", setup_new: "E", cost_old: 1, cost_new: 2 }], dir, PEAK);
    expect(row!.cost_old).toBeNull();
    expect(row!.cost_new).toBeNull();
    expect(row!.missing).toEqual([runLogPath(dir, "T99", "B"), runLogPath(dir, "T99", "E")]);
  });

  test("writeRepriced rewrites cost_old and cost_new and nothing else", () => {
    const store = new ForwardStore(":memory:");
    const pair = (task_id: string) => ({
      task_id,
      setup_old: "B",
      setup_new: "E",
      pass_old: true,
      pass_new: false,
      cost_old: 9,
      cost_new: 9,
      merged: "old" as const,
      blind_labels: { X: "old" as const, Y: "new" as const },
      seed: 7,
    });
    store.addPair(pair("F01"));
    store.addPair(pair("T99"));
    const rows = repricePairs(store.pairs(), runs(), PEAK);
    writeRepriced(store.db, rows);
    const after = store.pairs();
    expect(after.find((p) => p.task_id === "F01")).toMatchObject({ cost_old: B_USD, pass_old: true, pass_new: false, merged: "old", seed: 7 });
    expect(after.find((p) => p.task_id === "F01")!.cost_new).toBeCloseTo(E_PEAK_USD, 12);
    expect(after.find((p) => p.task_id === "T99")).toMatchObject({ cost_old: null, cost_new: null });
    store.close();
  });
});

describe("scripts/reprice-forward.ts", () => {
  const SCRIPT = resolve(import.meta.dir, "..", "scripts", "reprice-forward.ts");

  const setup = () => {
    const dir = tmp();
    const db = join(dir, "roster.db");
    const store = new ForwardStore(db);
    store.addPair({
      task_id: "F01",
      setup_old: "B",
      setup_new: "E",
      pass_old: true,
      pass_new: true,
      cost_old: 9,
      cost_new: E.total_cost_usd,
      merged: "old",
      blind_labels: { X: "old", Y: "new" },
      seed: 1,
    });
    store.close();
    const runs = join(dir, "runs");
    mkdirSync(runs);
    copyFileSync(join(FIXTURES, "F01.E.result.jsonl"), runLogPath(runs, "F01", "E"));
    copyFileSync(join(FIXTURES, "F01.B.result.jsonl"), runLogPath(runs, "F01", "B"));
    return { db, runs };
  };
  const run = (args: string[]) => {
    const r = Bun.spawnSync(["bun", SCRIPT, ...args], { cwd: resolve(import.meta.dir, "..") });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };
  const costs = (db: string) => {
    const d = new Database(db, { readonly: true });
    const row = d.query("SELECT cost_old, cost_new FROM forward_pairs WHERE task_id = 'F01'").get() as { cost_old: number; cost_new: number };
    d.close();
    return row;
  };

  test("--dry-run prints one line per pair and writes nothing", () => {
    const { db, runs } = setup();
    const r = run(["--db", db, "--runs", runs, "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("F01 B/E");
    expect(r.out).toContain("basis old=total_cost_usd new=deepseek-tokens");
    expect(r.out).toContain("dry run: 1 pairs, nothing written");
    expect(costs(db)).toEqual({ cost_old: 9, cost_new: E.total_cost_usd });
  });

  test("without --dry-run it writes the re-priced costs and lists a missing log", () => {
    const { db, runs } = setup();
    const r = run(["--db", db, "--runs", runs]);
    expect(r.code).toBe(0);
    const c = costs(db);
    expect(c.cost_old).toBe(B_USD);
    expect(c.cost_new).toBeGreaterThan(0);
    expect(c.cost_new).toBeLessThan(0.1);
    expect(r.out).toContain("wrote 1 pairs");

    const missing = run(["--db", db, "--runs", join(runs, "nowhere")]);
    expect(missing.out).toContain(`missing log: ${runLogPath(join(runs, "nowhere"), "F01", "B")}`);
    expect(costs(db).cost_old).toBeNull();
  });

  test("a database that does not exist is an error, not a new empty file", () => {
    const db = join(tmp(), "absent.db");
    const r = run(["--db", db, "--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("no forward database");
  });
});
