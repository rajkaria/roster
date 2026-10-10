// Score: survival (DESIGN.md §"Score: survival"). Share of the lines a session's commit(s) added that
// `git blame -w -M -C HEAD` still attributes to those commits.

export interface Survival {
  added: number;
  surviving: number;
  /** surviving ÷ added; 1 when nothing was added (nothing to lose). */
  ratio: number;
}

const GENERATED = [
  /(^|\/)dist\//,
  /\.min\.[^/]*$/,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/,
];

export function isGenerated(path: string): boolean {
  return GENERATED.some((re) => re.test(path));
}

function git(repo: string, args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["git", "-c", "core.quotepath=off", ...args], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
    maxBuffer: 256 * 1024 * 1024,
  });
  return { ok: r.exitCode === 0, out: r.stdout.toString() };
}

/** Added (non-blank, whitespace-insensitive) line count per non-generated file for one commit. */
function addedByFile(repo: string, sha: string): Map<string, number> {
  const res = git(repo, ["show", "-w", "--ignore-blank-lines", "-U0", "--no-renames", "--format=", sha]);
  if (!res.ok) throw new Error(`git show ${sha} failed in ${repo}`);
  const counts = new Map<string, number>();
  let file: string | null = null;
  let inHunk = false;
  for (const line of res.out.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = null;
      inHunk = false;
    } else if (!inHunk && line.startsWith("+++ ")) {
      file = line === "+++ /dev/null" ? null : line.slice(6);
    } else if (line.startsWith("@@")) {
      inHunk = true;
    } else if (inHunk && file && line.startsWith("+") && line.trim().length > 1 && !isGenerated(file)) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }
  return counts;
}

// Blame cache: repo + resolved HEAD + file → line count per full commit sha.
const blameCache = new Map<string, Map<string, number>>();

function blameCounts(repo: string, head: string, file: string): Map<string, number> {
  const key = `${repo}\0${head}\0${file}`;
  const hit = blameCache.get(key);
  if (hit) return hit;
  const counts = new Map<string, number>();
  const res = git(repo, ["blame", "-w", "-M", "-C", "--line-porcelain", head, "--", file]);
  if (res.ok) {
    // Each blamed line starts with "<40-hex sha> <orig> <final> [<group size>]"; content lines start with a tab.
    for (const line of res.out.split("\n")) {
      if (/^[0-9a-f]{40} \d+ \d+/.test(line)) {
        const sha = line.slice(0, 40);
        counts.set(sha, (counts.get(sha) ?? 0) + 1);
      }
    }
  }
  blameCache.set(key, counts);
  return counts;
}

function resolve(repo: string, rev: string): string {
  const r = git(repo, ["rev-parse", "--verify", `${rev}^{commit}`]);
  if (!r.ok) throw new Error(`cannot resolve ${rev} in ${repo}`);
  return r.out.trim();
}

export function survival(repoPath: string, commitShas: string[], headSha: string): Survival {
  const head = resolve(repoPath, headSha);
  const shas = new Set(commitShas.map((s) => resolve(repoPath, s)));

  const added = new Map<string, number>();
  for (const sha of shas) {
    for (const [file, n] of addedByFile(repoPath, sha)) added.set(file, (added.get(file) ?? 0) + n);
  }

  let total = 0;
  let surviving = 0;
  for (const [file, n] of added) {
    total += n;
    const blamed = blameCounts(repoPath, head, file);
    let mine = 0;
    for (const sha of shas) mine += blamed.get(sha) ?? 0;
    surviving += Math.min(mine, n);
  }
  return { added: total, surviving, ratio: total === 0 ? 1 : surviving / total };
}
