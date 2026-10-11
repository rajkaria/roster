import { describe, expect, test } from 'bun:test';
import { renderPrBody } from '../src/act/pr-body';

const base = {
  repo: 'acme/app',
  incumbent: 'A',
  promoted: 'C',
  evidenceLevel: 'B' as const,
  tasks: [
    { id: 't1', incumbentPass: false, candidatePass: true, costUsd: 0.5, traceUrl: 'https://trace/1', entireUrl: 'https://entire/1' },
    { id: 't2', incumbentPass: true, candidatePass: true, costUsd: null },
    { id: 't3', incumbentPass: false, candidatePass: false, costUsd: 1.234 },
  ],
  rejected: [{ candidate: 'D', reasons: ['regressed t2', 'cost'] }],
};

describe('renderPrBody', () => {
  const out = renderPrBody(base);

  test('has all sections in order', () => {
    const idx = ['## Summary', '## Evidence', '## Rejected candidates', '## Links'].map((s) => out.indexOf(s));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  test('totals line', () => {
    expect(out).toContain('2 of 3 tasks passed (incumbent 1 of 3)');
  });

  test('table rows with marks and cost formatting', () => {
    expect(out).toContain('| t1 | ✗ | ✓ | 0.50 |');
    expect(out).toContain('| t2 | ✓ | ✓ | n/a |');
    expect(out).toContain('| t3 | ✗ | ✗ | 1.23 |');
  });

  test('rejected reasons and links listed', () => {
    expect(out).toContain('- `D`');
    expect(out).toContain('  - regressed t2');
    expect(out).toContain('[trace](https://trace/1)');
    expect(out).toContain('[entire](https://entire/1)');
  });

  test('empty rejected says None', () => {
    const r = renderPrBody({ ...base, rejected: [] });
    expect(r).toMatch(/## Rejected candidates\n\nNone/);
  });

  test('no links says None; zero tasks', () => {
    const r = renderPrBody({ ...base, tasks: [], rejected: [] });
    expect(r).toMatch(/## Links\n\nNone/);
    expect(r).toContain('0 of 0 tasks passed (incumbent 0 of 0)');
  });

  test('no banned adjectives', () => {
    expect(out).not.toMatch(/significant|best/i);
  });

  test('escapes pipes in task ids', () => {
    const r = renderPrBody({ ...base, tasks: [{ id: 'a|b', incumbentPass: true, candidatePass: true, costUsd: 0 }] });
    expect(r).toContain('| a\\|b | ✓ | ✓ | 0.00 |');
  });
});
