import { expect, test } from "bun:test";
import { buildBook } from "../src/cfo/book";
import { diffBook, writeBook } from "../src/cfo/mcp";

const book = buildBook({
  periodDays: 30,
  promoted: "a",
  assumptions: { engineerMonthlyLoadedUsd: 15000, scaleSessionsPerWeek: 70 },
  setups: [{ id: "a", label: "A", costUsd: 30, sessions: 10, survivingChanges: 6, unattendedShare: 0.5 }],
});
const clone = () => JSON.parse(JSON.stringify(book));

function fake(readbacks: unknown[]) {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    call: async (tool: string) => {
      calls.push(tool);
      if (tool === "inspect_table_blocks") return readbacks[Math.min(i++, readbacks.length - 1)];
      return {};
    },
  };
}

test("matching readback succeeds in one attempt", async () => {
  const c = fake([{ book: clone() }]);
  expect(await writeBook(book, c)).toEqual({ ok: true, attempts: 1, diffs: [] });
  expect(c.calls).toEqual(["edit_table_blocks", "inspect_table_blocks"]);
});

test("numbers within 0.005 match, beyond do not", () => {
  const b = clone();
  b.department[0].monthlySpendUsd += 0.004;
  expect(diffBook(book, b)).toEqual([]);
  b.department[0].monthlySpendUsd += 0.01;
  expect(diffBook(book, b)).toHaveLength(1);
});

test("diff reports path, sent and got", () => {
  const b = clone();
  b.department[0].label = "Z";
  expect(diffBook(book, b)).toEqual([{ path: "department[0].label", sent: "A", got: "Z" }]);
});

test("mismatch retries once then fails with diffs", async () => {
  const bad = clone();
  bad.department[0].label = "Z";
  const r = await writeBook(book, fake([{ book: bad }]));
  expect(r.ok).toBe(false);
  expect(r.attempts).toBe(2);
  expect(r.diffs[0]!.path).toBe("department[0].label");
});

test("retry can recover", async () => {
  const bad = clone();
  bad.department[0].label = "Z";
  const r = await writeBook(book, fake([{ book: bad }, { book: clone() }]));
  expect(r).toEqual({ ok: true, attempts: 2, diffs: [] });
});

test("missing readback is empty, all fields differ", async () => {
  const r = await writeBook(book, fake([{}]), { retries: 0 });
  expect(r.ok).toBe(false);
  expect(r.attempts).toBe(1);
  expect(r.diffs.length).toBeGreaterThan(0);
});

test("client errors count as attempts and are not thrown", async () => {
  const client = {
    call: async () => {
      throw new Error("boom");
    },
  };
  const r = await writeBook(book, client);
  expect(r.ok).toBe(false);
  expect(r.attempts).toBe(2);
  expect(r.diffs[0]!.got).toBe("boom");
});
