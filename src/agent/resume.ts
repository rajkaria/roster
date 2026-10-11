export const MAX_FAILURES = 3;

export function nextSteps(
  plan: { steps: { key: string; dependsOn: string[] }[] },
  events: { key: string; status: 'started' | 'done' | 'failed' }[],
): string[] {
  const done = new Set<string>();
  const failures = new Map<string, number>();
  for (const e of events) {
    if (e.status === 'done') done.add(e.key);
    else if (e.status === 'failed') failures.set(e.key, (failures.get(e.key) ?? 0) + 1);
  }
  return plan.steps
    .filter(
      (s) =>
        !done.has(s.key) &&
        (failures.get(s.key) ?? 0) < MAX_FAILURES &&
        s.dependsOn.every((d) => done.has(d)),
    )
    .map((s) => s.key);
}
