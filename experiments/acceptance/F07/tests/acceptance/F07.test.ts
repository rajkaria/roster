import { describe, it, expect } from "bun:test";
import { writeBook, diffBook } from "../../src/cfo/mcp.ts";

describe("writeBook", () => {
  it("writes via edit_table_blocks, reads via inspect_table_blocks, and returns ok true when the readback matches", async () => {
    const sent = { value: 1.005 } as any;
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const client = {
      async call(tool: string, args: Record<string, unknown>) {
        calls.push({ tool, args });
        if (tool === "edit_table_blocks") return { ok: true };
        if (tool === "inspect_table_blocks") return { book: sent };
        throw new Error("unexpected tool");
      },
    };

    const res = await writeBook(sent, client);

    expect(res).toEqual({ ok: true, attempts: 1, diffs: [] });
    expect(calls.map((c) => c.tool)).toEqual(["edit_table_blocks", "inspect_table_blocks"]);
  });

  it("treats a missing readback book as empty, retries once, and succeeds if the retry matches", async () => {
    const sent = { value: 1.005 } as any;
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    let inspectCount = 0;
    const client = {
      async call(tool: string, args: Record<string, unknown>) {
        calls.push({ tool, args });
        if (tool === "edit_table_blocks") return { ok: true };
        if (tool === "inspect_table_blocks") {
          inspectCount++;
          if (inspectCount === 1) return {};
          return { book: sent };
        }
        throw new Error("unexpected tool");
      },
    };

    const res = await writeBook(sent, client);

    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(2);
    expect(res.diffs).toEqual([]);
    expect(calls.map((c) => c.tool)).toEqual([
      "edit_table_blocks",
      "inspect_table_blocks",
      "edit_table_blocks",
      "inspect_table_blocks",
    ]);
  });

  it("returns ok false with diffs after one retry when the readback stays different", async () => {
    const sent = { value: 1.005 } as any;
    const readback = { value: 2.005 } as any;
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const client = {
      async call(tool: string, args: Record<string, unknown>) {
        calls.push({ tool, args });
        if (tool === "edit_table_blocks") return { ok: true };
        if (tool === "inspect_table_blocks") return { book: readback };
        throw new Error("unexpected tool");
      },
    };

    const res = await writeBook(sent, client);

    expect(res.ok).toBe(false);
    expect(res.attempts).toBe(2);
    expect(res.diffs.length).toBeGreaterThan(0);
    expect(res.diffs[0].sent).toEqual(1.005);
    expect(res.diffs[0].got).toEqual(2.005);
  });

  it("honours opts.retries for extra retries", async () => {
    const sent = { value: 1 } as any;
    const readback = { value: 2 } as any;
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const client = {
      async call(tool: string, args: Record<string, unknown>) {
        calls.push({ tool, args });
        if (tool === "edit_table_blocks") return { ok: true };
        if (tool === "inspect_table_blocks") return { book: readback };
        throw new Error("unexpected tool");
      },
    };

    const res = await writeBook(sent, client, { retries: 2 });

    expect(res.ok).toBe(false);
    expect(res.attempts).toBe(3);
    expect(calls.filter((c) => c.tool === "edit_table_blocks")).toHaveLength(3);
    expect(calls.filter((c) => c.tool === "inspect_table_blocks")).toHaveLength(3);
  });

  it("does not throw on client errors and counts them as attempts", async () => {
    const sent = { value: 1 } as any;
    let clientCalls = 0;
    const client = {
      async call(_tool: string, _args: Record<string, unknown>) {
        clientCalls++;
        throw new Error("client unavailable");
      },
    };

    const res = await writeBook(sent, client, { retries: 0 });

    expect(res.ok).toBe(false);
    expect(res.attempts).toBe(1);
    expect(clientCalls).toBe(1);
  });
});

describe("diffBook", () => {
  it("treats numeric differences within 0.005 as equal", () => {
    expect(diffBook({ value: 1.0 } as any, { value: 1.004 } as any)).toEqual([]);
    expect(diffBook({ value: 1.0 } as any, { value: 1.005 } as any)).toEqual([]);
  });

  it("returns a diff when a numeric difference exceeds 0.005", () => {
    const diffs = diffBook({ value: 1.0 } as any, { value: 1.006 } as any);

    expect(diffs).toHaveLength(1);
    expect(diffs[0].path).toContain("value");
    expect(diffs[0].sent).toBe(1.0);
    expect(diffs[0].got).toBe(1.006);
  });
});
