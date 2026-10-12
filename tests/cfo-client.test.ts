// T69: the cfo.ai MCP bridge runs `claude -p`; here `claude` is a stub binary that plays a connected cfoai
// server (edit stores the book, inspect returns it), a server that is not configured, or one not authenticated.
// The book under test is built from the real published review (reports/rajkaria__roster/review.json).
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CFO_MCP_URL,
  CfoBridgeError,
  CfoNotConnectedError,
  NOT_CONNECTED_MESSAGE,
  createCfoClient,
} from "../src/cfo/client";
import { writeBook } from "../src/cfo/mcp";
import { ASSUMPTIONS, main } from "../scripts/book-self";
import { loadBook } from "../web/lib/book.ts";

const DIR = mkdtempSync(join(tmpdir(), "cfo-client-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

// The stub: argv is claude's. It logs argv, then answers per STUB_MODE in the `--output-format json` envelope.
const STUB = join(DIR, "claude");
writeFileSync(
  STUB,
  `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const dir = process.env.STUB_DIR;
appendFileSync(dir + "/argv.jsonl", JSON.stringify(argv) + "\\n");
const mode = process.env.STUB_MODE;
const out = (result, isError = false) => console.log(JSON.stringify({ type: "result", is_error: isError, result }));
if (mode === "unauthenticated") {
  console.error('MCP server "cfoai": needs authentication');
  process.exit(1);
}
if (mode === "not_configured") { out("CFO_NOT_CONNECTED"); process.exit(0); }
if (mode === "garbage") { out("I could not do that."); process.exit(0); }
const prompt = argv[argv.length - 1];
const tool = /^TOOL: (.+)$/m.exec(prompt)[1];
const args = JSON.parse(/^ARGS: (.+)$/m.exec(prompt)[1]);
const state = dir + "/state.json";
if (tool === "edit_table_blocks") { writeFileSync(state, JSON.stringify(args.update.values)); out(JSON.stringify({ ok: true })); }
else if (tool === "inspect_table_blocks") {
  // The live server's read shape: columns by display_name, one row per dimension member with values in column order.
  const v = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : { columns: [], rows: [] };
  const read = {
    columns: v.columns.map((display_name) => ({ display_name })),
    rows: [{ axis: true }, ...v.rows.map(([key, ...cells]) => ({ member: /\\[(.+)\\]$/.exec(key)[1], values: cells.map((value) => ({ value })) }))],
  };
  out("\`\`\`json\\n" + JSON.stringify(read) + "\\n\`\`\`");
} else { out("CFO_NOT_CONNECTED"); }
`,
);
chmodSync(STUB, 0o755);

function stubClient(mode: string, sub: string) {
  const dir = join(DIR, sub);
  mkdirSync(dir, { recursive: true });
  const client = createCfoClient({ bin: STUB, env: { ...process.env, STUB_MODE: mode, STUB_DIR: dir } });
  const argvLog = (): string[][] =>
    existsSync(join(dir, "argv.jsonl"))
      ? readFileSync(join(dir, "argv.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
      : [];
  return { client, argvLog };
}

const ROOT = join(import.meta.dir, "..");

describe("cfo.ai bridge", () => {
  test("a connected bridge round-trips edit and inspect through writeBook", async () => {
    const { client, argvLog } = stubClient("connected", "ok");
    const out = join(DIR, "ok-book.json");
    const file = await main([], { out });
    const sent = { department: file.department, scenario: file.scenario, assumptions: file.assumptions };
    expect(await writeBook(sent, client)).toEqual({ ok: true, attempts: 1, diffs: [] });

    const calls = argvLog();
    expect(calls).toHaveLength(2);
    for (const argv of calls) {
      expect(argv).toContain("-p");
      expect(argv).toContain("--strict-mcp-config");
      const cfg = JSON.parse(argv[argv.indexOf("--mcp-config") + 1]!);
      expect(cfg).toEqual({ mcpServers: { cfoai: { type: "http", url: CFO_MCP_URL } } });
    }
    expect(calls[0]![calls[0]!.indexOf("--allowedTools") + 1]).toBe("mcp__cfoai__edit_table_blocks");
    expect(calls[1]![calls[1]!.indexOf("--allowedTools") + 1]).toBe("mcp__cfoai__inspect_table_blocks");
    // The prompt follows "--": --tools and --allowedTools are lists and would otherwise swallow it.
    for (const argv of calls) expect(argv[argv.length - 2]).toBe("--");
  });

  test("a server that is not configured gives the typed not-connected error", async () => {
    const { client } = stubClient("not_configured", "nc");
    const err = (await client.call("inspect_table_blocks", {}).catch((e) => e)) as CfoNotConnectedError;
    expect(err).toBeInstanceOf(CfoNotConnectedError);
    expect(err.code).toBe("CFO_NOT_CONNECTED");
    expect(err.message).toBe(
      "cfo.ai not connected: run `claude mcp add --transport http cfoai https://api.cfo.ai/mcp`",
    );
  });

  test("a server that is not authenticated gives the same typed error", async () => {
    const { client } = stubClient("unauthenticated", "auth");
    const err = (await client.call("edit_table_blocks", { update: {} }).catch((e) => e)) as CfoNotConnectedError;
    expect(err).toBeInstanceOf(CfoNotConnectedError);
    expect(err.message).toBe(NOT_CONNECTED_MESSAGE);
  });

  test("a non-JSON answer is a bridge error, not a not-connected error", async () => {
    const { client } = stubClient("garbage", "garbage");
    const err = await client.call("inspect_table_blocks", {}).catch((e: CfoNotConnectedError) => e);
    expect(err).toBeInstanceOf(CfoBridgeError);
  });

  test("a missing claude binary is a bridge error", async () => {
    const client = createCfoClient({ bin: join(DIR, "no-such-claude") });
    expect(await client.call("inspect_table_blocks", {}).catch((e) => e)).toBeInstanceOf(CfoBridgeError);
  });
});

describe("scripts/book-self.ts", () => {
  const review = JSON.parse(readFileSync(join(ROOT, "reports/rajkaria__roster/review.json"), "utf8"));

  test("writes a book.json that loadBook parses, one row per reviewed setup", async () => {
    const out = join(DIR, "book.json");
    await main([], { out });
    const json = JSON.parse(readFileSync(out, "utf8"));
    const book = loadBook(json);
    expect(book.rows.map((r) => r.setup)).toEqual(review.setups.map((s: { setup_id: string }) => s.setup_id));
    for (const row of book.rows) {
      expect(row.monthly).toMatch(/^\$[\d,]+\.\d\d$/);
      expect(row.unattended).toMatch(/%$/);
    }
    expect(book.scenario?.hire).toBe("$12,000.00");
    const plan = JSON.parse(readFileSync(join(ROOT, "reports/self/cfo-plan.json"), "utf8"));
    expect(json.shareUrl).toBe(plan.shareUrls?.book ?? null);
    expect(book.shareUrl).toBe(json.shareUrl);
    expect(json.assumptions).toEqual(ASSUMPTIONS);
    expect(Object.values(json.assumptionLabels).every((l) => String(l).startsWith("assumption:"))).toBe(true);
    expect(json.period.days).toBeGreaterThan(0);
    expect(json.cfo).toEqual({ written: false, verified: false, error: "not attempted: run with --write" });
  });

  test("--write records a verified write when connected", async () => {
    const { client } = stubClient("connected", "write-ok");
    const out = join(DIR, "book-write.json");
    const file = await main(["--write"], { out, client });
    expect(file.cfo).toEqual({ written: true, verified: true, error: null });
    expect(JSON.parse(readFileSync(out, "utf8")).cfo).toEqual(file.cfo);
  });

  test("--write records exactly what is missing when not connected", async () => {
    const { client } = stubClient("not_configured", "write-nc");
    const file = await main(["--write"], { out: join(DIR, "book-nc.json"), client });
    expect(file.cfo).toEqual({ written: false, verified: false, error: NOT_CONNECTED_MESSAGE });
  });
});
