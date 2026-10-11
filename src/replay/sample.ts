// Stratified task sample for the coordinator plan (DESIGN.md §"Plan (coordinator)"): at most `max` eligible
// replay tasks, split as evenly as possible over the three difficulty terciles, a short tercile's leftover
// filled from the others, and a seeded shuffle inside each tercile so a logged seed reproduces the pick.

/** One candidate as the sampler sees it: the session id, its difficulty tercile, and whether it may replay. */
export interface SampleTask {
  id: string;
  tercile: 1 | 2 | 3;
  eligible: boolean;
}

export interface SampleOptions {
  /** Upper bound on the sample size. */
  max: number;
  /** Same input + seed → same output. */
  seed: number;
}

/** Highest tercile first: the remainder of the even split, and the first spare capacity, go here. */
const ORDER: (1 | 2 | 3)[] = [3, 2, 1];

/** mulberry32: a small deterministic PRNG, so a logged seed reproduces the pick. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A per-tercile seed, so one tercile's shuffle does not depend on another's. */
function tercileSeed(seed: number, tercile: 1 | 2 | 3): number {
  return (Math.imul(seed >>> 0, 0x9e3779b1) ^ Math.imul(tercile, 0x85ebca6b)) >>> 0;
}

/** Fisher–Yates, seeded. */
function shuffle<T>(items: T[], random: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/** Codepoint order, so the sorted output does not depend on the machine's locale. */
function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Picks at most `max` eligible task ids, spread evenly across terciles (remainder to the highest terciles
 * first), filling a tercile that runs out of tasks from the others. Sorted by id.
 */
export function sampleTasks(tasks: SampleTask[], opts: SampleOptions): string[] {
  const max = Math.max(0, Math.floor(opts.max));
  if (max === 0) return [];

  const pools = new Map<1 | 2 | 3, SampleTask[]>([
    [1, []],
    [2, []],
    [3, []],
  ]);
  for (const t of tasks) if (t.eligible) pools.get(t.tercile)!.push(t);

  // Even split; the remainder goes to the highest terciles first.
  const base = Math.floor(max / 3);
  const remainder = max % 3;
  const quota = new Map<1 | 2 | 3, number>(ORDER.map((t, i) => [t, base + (i < remainder ? 1 : 0)]));

  // A tercile with fewer tasks than its quota does not use the rest: it goes back to the pool.
  let leftover = max;
  for (const t of ORDER) {
    const take = Math.min(quota.get(t)!, pools.get(t)!.length);
    quota.set(t, take);
    leftover -= take;
  }
  const spare = (t: 1 | 2 | 3) => pools.get(t)!.length - quota.get(t)!;
  for (let i = 0; leftover > 0 && ORDER.some((t) => spare(t) > 0); i++) {
    const t = ORDER[i % ORDER.length]!;
    if (spare(t) > 0) {
      quota.set(t, quota.get(t)! + 1);
      leftover--;
    }
  }

  const picked: string[] = [];
  for (const t of ORDER) {
    // Sorting first keeps the sample independent of the order the caller listed its tasks in.
    const pool = pools
      .get(t)!
      .slice()
      .sort((a, b) => byId(a.id, b.id));
    for (const task of shuffle(pool, rng(tercileSeed(opts.seed, t))).slice(0, quota.get(t)!)) picked.push(task.id);
  }
  return picked.sort(byId);
}
