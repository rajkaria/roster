// A session's tokens, counted once (post-deadline, 13 Oct). Two overcounts were found in public repos' data:
// - Entire's per-checkpoint token_usage covers the transcript from `checkpoint_transcript_start`, or from the start
//   of the session when that is null or 0, so a slice without it is a running total, not a delta. Summing a
//   72-checkpoint session's slices counted its cache reads 33 times (17.9 billion against 542 million).
// - Claude Code writes one transcript row per content block, each repeating the response's usage, so usage is
//   counted once per (message id, request id).
import { describe, expect, test } from "bun:test";
import { mergeSliceTokens, transcriptTokens } from "../src/ingest/parse.ts";

const t = (cr: number, out = 0) => ({ in: 0, out, cr, cw: 0 });

describe("mergeSliceTokens", () => {
  test("running totals (no transcript start): the latest one is the session's total", () => {
    expect(
      mergeSliceTokens([
        { created: "2026-09-27T13:21:00Z", fromStart: true, tokens: t(7_576_957) },
        { created: "2026-09-27T13:23:00Z", fromStart: true, tokens: t(8_973_469) },
        { created: "2026-09-27T13:29:00Z", fromStart: true, tokens: t(10_966_692) },
      ]),
    ).toEqual(t(10_966_692));
  });

  test("slices that start mid-transcript are deltas and add up", () => {
    expect(
      mergeSliceTokens([
        { created: "2026-03-16T20:45:00Z", fromStart: true, tokens: t(725_886) },
        { created: "2026-03-16T21:19:00Z", fromStart: false, tokens: t(1_490_482) },
        { created: "2026-03-16T21:24:00Z", fromStart: false, tokens: t(1_099_535) },
      ]),
    ).toEqual(t(3_315_903));
  });

  test("a running total after deltas replaces them; order is by creation time, not input order", () => {
    expect(
      mergeSliceTokens([
        { created: "2026-03-17T16:14:00Z", fromStart: true, tokens: t(4_833_911) },
        { created: "2026-03-17T14:37:00Z", fromStart: true, tokens: t(862_495) },
        { created: "2026-03-17T16:42:00Z", fromStart: false, tokens: t(100) },
        { created: "2026-03-17T16:07:00Z", fromStart: false, tokens: t(2_224_003) },
      ]),
    ).toEqual(t(4_834_011));
  });

  test("slices without usage are skipped; none at all is null", () => {
    expect(mergeSliceTokens([{ created: "a", fromStart: true, tokens: null }, { created: "b", fromStart: false, tokens: t(5) }])).toEqual(t(5));
    expect(mergeSliceTokens([{ created: "a", fromStart: true, tokens: null }])).toBeNull();
  });
});

describe("transcriptTokens", () => {
  const row = (id: string, req: string, usage: object) => ({ type: "assistant", requestId: req, message: { id, model: "claude-opus-5-5", usage } });
  const u = { input_tokens: 3, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 };

  test("a response split over several content-block rows is counted once", () => {
    expect(transcriptTokens([row("m1", "r1", u), row("m1", "r1", u), row("m1", "r1", u), row("m2", "r2", u)])).toEqual({ in: 6, out: 20, cr: 2000, cw: 100 });
  });

  test("rows without a message id are each counted", () => {
    const noId = { type: "assistant", message: { usage: u } };
    expect(transcriptTokens([noId, noId])).toEqual({ in: 6, out: 20, cr: 2000, cw: 100 });
  });

  test("no usage at all is null", () => {
    expect(transcriptTokens([{ type: "user", message: { content: "hi" } }])).toBeNull();
  });
});
