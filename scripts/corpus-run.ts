// Public corpus runner (DESIGN.md §"Public corpus"): take the top-scoring candidates from
// scripts/corpus-find.ts and review them one at a time. A review that throws is recorded and the run
// carries on, so one broken public repo cannot end the corpus.
//
// The review and write effects are injected: this module owns the order and the report layout, the
// caller owns the sandbox and the filesystem (see tests/corpus-run.test.ts for the contract).

export interface CorpusCandidate {
  repo: string;
  score: number;
}

export interface CorpusFailure {
  repo: string;
  reason: string;
}

export interface CorpusResult {
  done: string[];
  failed: CorpusFailure[];
}

export interface RunCorpusOpts {
  candidates: CorpusCandidate[];
  top: number;
  review: (repo: string) => Promise<unknown>;
  write: (path: string, data: unknown) => Promise<void>;
}

/** `owner/name` becomes `owner__name` under reports/corpus (the layout corpus-find.ts already writes). */
export const slugifyRepo = (repo: string): string => repo.replace(/\//g, "__");

export const reviewPath = (repo: string): string => `reports/corpus/${slugifyRepo(repo)}/review.json`;

export const INDEX_PATH = "reports/corpus/index.json";

/** Highest score first; equal scores are ordered by repo name so the pick is deterministic. */
export function rankCorpus(candidates: CorpusCandidate[], top: number): CorpusCandidate[] {
  const limit = Math.max(0, Math.floor(top));
  return [...candidates]
    .sort((a, b) => b.score - a.score || a.repo.localeCompare(b.repo))
    .slice(0, limit);
}

/** Review the top `top` candidates sequentially. Writes each success, then the index, and returns it. */
export async function runCorpus(opts: RunCorpusOpts): Promise<CorpusResult> {
  const done: string[] = [];
  const failed: CorpusFailure[] = [];
  for (const { repo } of rankCorpus(opts.candidates, opts.top)) {
    try {
      const report = await opts.review(repo);
      // Write only on success: a failed repo has no review to publish, but stays in the index.
      await opts.write(reviewPath(repo), report);
      done.push(repo);
    } catch (err) {
      failed.push({ repo, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  const index: CorpusResult = { done, failed };
  await opts.write(INDEX_PATH, index);
  return index;
}
