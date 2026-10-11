import { describe, expect, test } from 'bun:test';
import { detect } from '../src/obs/detections';

type R = Parameters<typeof detect>[0]['replays'][0];
const r = (o: Partial<R> = {}): R => ({
  task: 't1', setup: 'a', suitePass: true, hiddenPass: true, scopeOk: true, costUsd: 1, failureCodes: [], ...o,
});
const run = (replays: R[], unmapped: Record<string, number> = {}) =>
  detect({ replays, incumbent: 'inc', unmappedLineShare: unmapped });

describe('detect', () => {
  test('D1 silent pass', () => {
    const d = run([
      r({ hiddenPass: false }),
      r({ task: 't2', scopeOk: false }),
      r({ task: 't3', suitePass: false, hiddenPass: false }),
      r({ task: 't4' }),
    ]);
    expect(d.map((x) => [x.id, x.task])).toEqual([['D1', 't1'], ['D1', 't2']]);
  });

  test('D2 strictly above 0.30', () => {
    expect(run([], { x: 0.31, y: 0.3 }).map((x) => x.setup)).toEqual(['x']);
  });

  test('D3 cost anomaly, nulls ignored', () => {
    const inc = [
      r({ setup: 'inc', task: 't7', costUsd: 1 }),
      r({ setup: 'inc', task: 't9', costUsd: 3 }),
      r({ setup: 'inc', task: 't8', costUsd: null }),
    ];
    const d = run([...inc, r({ costUsd: 6.1 }), r({ task: 't2', costUsd: 6 }), r({ task: 't3', costUsd: null })]);
    expect(d.filter((x) => x.id === 'D3').map((x) => x.task)).toEqual(['t1']);
  });

  test('no incumbent costs → no D3', () => {
    expect(run([r({ costUsd: 1000 }), r({ setup: 'inc', costUsd: null })])).toEqual([]);
  });

  test('D4 one per task, needs 2 distinct setups', () => {
    const f6 = ['F6'];
    const d = run([
      r({ setup: 'a', failureCodes: f6 }),
      r({ setup: 'b', failureCodes: f6 }),
      r({ setup: 'c', failureCodes: f6 }),
      r({ task: 't2', setup: 'a', failureCodes: f6 }),
      r({ task: 't2', setup: 'a', failureCodes: f6 }),
    ]);
    expect(d.filter((x) => x.id === 'D4').map((x) => x.task)).toEqual(['t1']);
  });

  test('sorted by id, setup, task', () => {
    const d = run(
      [
        r({ setup: 'b', task: 'z', hiddenPass: false }),
        r({ setup: 'a', task: 'y', hiddenPass: false }),
        r({ setup: 'a', task: 'x', hiddenPass: false }),
      ],
      { q: 0.9 },
    );
    expect(d.map((x) => `${x.id}${x.setup}${x.task ?? ''}`)).toEqual(['D1ax', 'D1ay', 'D1bz', 'D2q']);
  });
});
