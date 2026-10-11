import { describe, expect, test } from 'bun:test';
import { nextSteps } from '../src/agent/resume';

const plan = {
  steps: [
    { key: 'a', dependsOn: [] },
    { key: 'b', dependsOn: ['a'] },
    { key: 'c', dependsOn: ['b'] },
    { key: 'd', dependsOn: [] },
  ],
};

const failed = (key: string, n: number) =>
  Array.from({ length: n }, () => ({ key, status: 'failed' as const }));

describe('nextSteps', () => {
  test('fresh run returns steps with no unmet deps, in plan order', () => {
    expect(nextSteps(plan, [])).toEqual(['a', 'd']);
  });
  test('done steps are not repeated; dependents unlock', () => {
    expect(nextSteps(plan, [{ key: 'a', status: 'done' }])).toEqual(['b', 'd']);
  });
  test('started but unfinished step is returned again', () => {
    expect(nextSteps(plan, [{ key: 'a', status: 'started' }])).toEqual(['a', 'd']);
  });
  test('failed step is retried until 3 failures', () => {
    expect(nextSteps(plan, failed('a', 2))).toEqual(['a', 'd']);
    expect(nextSteps(plan, failed('a', 3))).toEqual(['d']);
  });
  test('dependents of an exhausted step are not returned', () => {
    const ev = [{ key: 'a', status: 'done' as const }, ...failed('b', 3)];
    expect(nextSteps(plan, ev)).toEqual(['d']);
  });
  test('done after earlier failures counts as done', () => {
    const ev = [
      { key: 'a', status: 'failed' as const },
      { key: 'a', status: 'started' as const },
      { key: 'a', status: 'done' as const },
    ];
    expect(nextSteps(plan, ev)).toEqual(['b', 'd']);
  });
  test('all done returns empty', () => {
    const ev = plan.steps.map((s) => ({ key: s.key, status: 'done' as const }));
    expect(nextSteps(plan, ev)).toEqual([]);
  });
});
