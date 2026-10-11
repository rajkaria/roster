import { describe, expect, test } from 'bun:test';
import { checkEligibility } from '../src/replay/eligibility';

const ok = { installs: true, suitePasses: true };
const mk = (over = {}) => ({ userPrompts: 1, hiddenTests: ['a.test.ts'], strategy: 'replay', ...over });
const spy = () => {
  const s = { calls: 0 };
  return { s, probe: async () => (s.calls++, ok) };
};

describe('checkEligibility', () => {
  test('import is none and skips probe', async () => {
    const { s, probe } = spy();
    const r = await checkEligibility(mk({ strategy: 'import' }), probe);
    expect(r).toEqual({ eligible: false, track: 'none', reason: 'imported history' });
    expect(s.calls).toBe(0);
  });
  test('too many prompts skips probe', async () => {
    const { s, probe } = spy();
    const r = await checkEligibility(mk({ userPrompts: 3 }), probe);
    expect(r.eligible).toBe(false);
    expect(r.track).toBe('none');
    expect(s.calls).toBe(0);
  });
  test('2 prompts allowed', async () => {
    const r = await checkEligibility(mk({ userPrompts: 2 }), async () => ok);
    expect(r.eligible).toBe(true);
  });
  test('install failure', async () => {
    const r = await checkEligibility(mk(), async () => ({ installs: false, suitePasses: false }));
    expect(r).toEqual({ eligible: false, track: 'none', reason: 'parent does not install' });
  });
  test('suite failure', async () => {
    const r = await checkEligibility(mk(), async () => ({ installs: true, suitePasses: false }));
    expect(r.eligible).toBe(false);
    expect(r.track).toBe('none');
  });
  test('no hidden tests is judge-only', async () => {
    const r = await checkEligibility(mk({ hiddenTests: [] }), async () => ok);
    expect(r.eligible).toBe(true);
    expect(r.track).toBe('judge-only');
  });
  test('hidden tests is tests track', async () => {
    const r = await checkEligibility(mk(), async () => ok);
    expect(r.eligible).toBe(true);
    expect(r.track).toBe('tests');
  });
});
