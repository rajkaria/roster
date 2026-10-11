export type Detection = { id: 'D1' | 'D2' | 'D3' | 'D4'; setup?: string; task?: string; detail: string };

export type DetectInput = {
  replays: {
    task: string;
    setup: string;
    suitePass: boolean;
    hiddenPass: boolean;
    scopeOk: boolean;
    costUsd: number | null;
    failureCodes: string[];
  }[];
  incumbent: string;
  unmappedLineShare: Record<string, number>;
};

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const cmp = (a: string | undefined, b: string | undefined) => (a ?? '').localeCompare(b ?? '');

export function detect(input: DetectInput): Detection[] {
  const out: Detection[] = [];

  for (const r of input.replays) {
    if (r.suitePass && (!r.hiddenPass || !r.scopeOk)) {
      const why = [!r.hiddenPass && 'hidden tests failed', !r.scopeOk && 'scope guard failed'].filter(Boolean).join(' and ');
      out.push({ id: 'D1', setup: r.setup, task: r.task, detail: `visible suite passed but ${why}` });
    }
  }

  for (const [setup, share] of Object.entries(input.unmappedLineShare)) {
    if (share > 0.3) out.push({ id: 'D2', setup, detail: `${(share * 100).toFixed(1)}% of lines unmapped (limit 30%)` });
  }

  const inc = input.replays
    .filter((r) => r.setup === input.incumbent && r.costUsd !== null)
    .map((r) => r.costUsd as number);
  if (inc.length > 0) {
    const med = median(inc);
    for (const r of input.replays) {
      if (r.costUsd !== null && r.costUsd > 3 * med) {
        out.push({ id: 'D3', setup: r.setup, task: r.task, detail: `cost $${r.costUsd} exceeds 3x incumbent median $${med}` });
      }
    }
  }

  const f6 = new Map<string, Set<string>>();
  for (const r of input.replays) {
    if (r.failureCodes.includes('F6')) {
      if (!f6.has(r.task)) f6.set(r.task, new Set());
      f6.get(r.task)!.add(r.setup);
    }
  }
  for (const [task, setups] of f6) {
    if (setups.size >= 2) out.push({ id: 'D4', task, detail: `F6 on ${setups.size} setups: ${[...setups].sort().join(', ')}` });
  }

  return out.sort((a, b) => cmp(a.id, b.id) || cmp(a.setup, b.setup) || cmp(a.task, b.task));
}
