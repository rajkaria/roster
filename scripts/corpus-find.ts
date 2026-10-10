// Corpus finder (DESIGN.md §"Public corpus"): public repos with Entire checkpoints and runnable tests.
// Reads GitHub metadata through `gh api` and fetches only the checkpoint branch tip (parsed by src/ingest).
// No code from a candidate repo is executed; the test command is detected from file names and package.json text.
// Bounded: --max-repos (default 40), --repo-timeout seconds per git call (60), --budget-min total (40); progress goes to --log.
//
//   bun scripts/corpus-find.ts [--max-repos 40] [--repo-timeout 60] [--budget-min 40] [--windows N] [--out path] [--log path]
//   bun scripts/corpus-find.ts --record      # write the redacted search sample used by tests/corpus.test.ts

import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CHECKPOINT_BRANCH, CHECKPOINT_REFS } from "../src/ingest/fetch";
import { parseCheckpoints } from "../src/ingest/parse";

export interface Candidate {
  repo: string;
  url: string;
  stars: number;
  language: string | null;
  license: string | null;
  sessions: number;
  distinct_setups: number;
  harnesses: string[];
  models: string[];
  test_command: string | null;
  score: number;
}

export interface RepoGroup {
  commits: number;
  checkpoints: string[];
}

const TRAILER = /^Entire-Checkpoint:\s*([0-9A-Za-z]+)\s*$/gm;

/** Group search/commits pages by public repo, collecting unique `Entire-Checkpoint` ids. */
export function groupByRepo(pages: any[]): Map<string, RepoGroup> {
  const groups = new Map<string, RepoGroup>();
  for (const page of pages) {
    for (const item of page?.items ?? []) {
      const repo = item?.repository;
      if (!repo?.full_name || repo.private) continue;
      const ids = [...String(item?.commit?.message ?? "").matchAll(TRAILER)].map((m) => m[1] as string);
      if (!ids.length) continue;
      const g = groups.get(repo.full_name) ?? { commits: 0, checkpoints: [] };
      g.commits++;
      for (const id of ids) if (!g.checkpoints.includes(id)) g.checkpoints.push(id);
      groups.set(repo.full_name, g);
    }
  }
  return groups;
}

// OSI-approved licences by SPDX id (the ones that occur on GitHub in practice).
const OSI = new Set([
  "0BSD", "AFL-3.0", "AGPL-3.0", "AGPL-3.0-only", "AGPL-3.0-or-later", "Apache-2.0", "Artistic-2.0",
  "BSD-1-Clause", "BSD-2-Clause", "BSD-3-Clause", "BSL-1.0", "CDDL-1.0", "ECL-2.0", "EPL-1.0", "EPL-2.0",
  "EUPL-1.1", "EUPL-1.2", "GPL-2.0", "GPL-2.0-only", "GPL-2.0-or-later", "GPL-3.0", "GPL-3.0-only",
  "GPL-3.0-or-later", "ISC", "LGPL-2.1", "LGPL-2.1-only", "LGPL-2.1-or-later", "LGPL-3.0", "LGPL-3.0-only",
  "LGPL-3.0-or-later", "MIT", "MIT-0", "MPL-2.0", "MS-PL", "MS-RL", "NCSA", "OFL-1.1", "OSL-3.0",
  "PostgreSQL", "UPL-1.0", "Unlicense", "Zlib",
]);

export const isOsiLicense = (spdx: string | null | undefined): boolean => !!spdx && OSI.has(spdx);

/** Detect a test command from root file names (+ package.json text). Never runs anything. */
export function detectTestCommand(rootFiles: string[], packageJson?: string): string | null {
  const has = (f: string) => rootFiles.includes(f);
  if (has("package.json") && packageJson) {
    try {
      const test = JSON.parse(packageJson)?.scripts?.test;
      if (typeof test === "string" && test.trim() && !/no test specified/i.test(test)) {
        return has("bun.lock") || has("bun.lockb") ? "bun run test" : "npm test";
      }
    } catch {
      // unparsable package.json: fall through
    }
  }
  if (has("Cargo.toml")) return "cargo test";
  if (has("go.mod")) return "go test ./...";
  if (has("pyproject.toml") || has("pytest.ini") || has("tox.ini")) {
    return has("tests") || has("test") || has("pytest.ini") ? "pytest" : null;
  }
  return null;
}

export const scoreCandidate = (c: Pick<Candidate, "sessions" | "distinct_setups">): number =>
  c.sessions * c.distinct_setups;

/** Keep OSI-licensed repos with a detected test command and ≥1 session; rank by score, then stars. */
export function rankCandidates(list: Candidate[]): Candidate[] {
  return list
    .filter((c) => isOsiLicense(c.license) && c.test_command && c.sessions > 0)
    .map((c) => ({ ...c, score: scoreCandidate(c) }))
    .sort((a, b) => b.score - a.score || b.stars - a.stars || a.repo.localeCompare(b.repo));
}

// ---- I/O (not unit-tested; exercised by the live run) ----

async function gh(args: string[]): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    const p = Bun.spawn(["gh", "api", ...args], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code === 0) return JSON.parse(out);
    const notFound = /HTTP 404|Not Found/.test(out + err);
    if (notFound || attempt >= 3) throw Object.assign(new Error("gh api " + args.join(" ") + " failed: " + err.trim().slice(0, 200)), { notFound });
    await sleep(1000 * attempt); // transient (TLS handshake, timeout): retry
  }
}

/** Like gh(), but a 404 yields `fallback`; any other failure still throws. */
const ghOr = (args: string[], fallback: any) =>
  gh(args).catch((e) => {
    if (e.notFound) return fallback;
    throw e;
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Keep only what grouping needs; drops author/committer names and emails. */
export function redactSearchPage(page: any) {
  return {
    total_count: page.total_count,
    items: (page.items ?? []).map((i: any) => ({
      sha: i.sha,
      repository: { full_name: i.repository?.full_name, private: i.repository?.private },
      commit: { message: String(i.commit?.message ?? "").split("\n").filter((l) => /^Entire-Checkpoint:/.test(l)).map((l) => l).join("\n\n") },
    })),
  };
}

function searchArgs(from: string, to: string, page: number): string[] {
  return [
    "-X", "GET", "search/commits",
    "-f", `q=Entire-Checkpoint committer-date:${from}..${to}`,
    "-f", "per_page=100", "-f", `page=${page}`,
  ];
}

const day = (d: Date) => d.toISOString().slice(0, 10);

async function searchWindows(windows: number, log: (m: string) => void): Promise<any[]> {
  const pages: any[] = [];
  const end = new Date();
  for (let w = 0; w < windows; w++) {
    const to = new Date(end.getTime() - w * 3 * 864e5);
    const from = new Date(to.getTime() - 2 * 864e5);
    for (let page = 1; page <= 10; page++) {
      let res: any;
      try {
        res = await gh(searchArgs(day(from), day(to), page));
      } catch (e) {
        log("[search] " + (e as Error).message);
        await sleep(15000);
        break;
      }
      pages.push(res);
      log(`[search] ${day(from)}..${day(to)} page ${page}: ${res.items?.length ?? 0} commits`);
      if ((res.items?.length ?? 0) < 100) break;
      await sleep(2500); // search API: 30 req/min
    }
  }
  return pages;
}

/** Fetch only the checkpoint branch tip into a fresh repo. Each git call is SIGKILLed after `timeoutMs`. */
async function fetchBranchTip(cloneUrl: string, dir: string, timeoutMs: number): Promise<string | null> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const git = async (args: string[]) => {
    const p = Bun.spawn(["git", ...args], {
      cwd: dir, stdout: "pipe", stderr: "pipe", timeout: timeoutMs, killSignal: "SIGKILL",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    return code === 0 ? null : `exit ${code}: ${err.trim().slice(0, 150)}`;
  };
  const initErr = await git(["init", "-q"]);
  if (initErr) return initErr;
  const spec = `+refs/heads/${CHECKPOINT_BRANCH}:refs/heads/${CHECKPOINT_BRANCH}`;
  const branchErr = await git(["fetch", "-q", "--depth=1", "--no-tags", cloneUrl, spec]);
  if (!branchErr || !/couldn't find remote ref/.test(branchErr)) return branchErr;
  // Fallback backend: refs/entire/checkpoints/* (see src/ingest/fetch.ts)
  return git(["fetch", "-q", "--depth=1", "--no-tags", cloneUrl, `+${CHECKPOINT_REFS}*:${CHECKPOINT_REFS}*`]);
}

async function inspect(name: string, timeoutMs: number, log: (m: string) => void): Promise<Candidate | null> {
  const drop = (why: string) => (log(`[drop] ${name}: ${why}`), null);
  const meta = await gh([`repos/${name}`]);
  if (meta.private || meta.archived || meta.fork) return drop("private/archived/fork");
  const license: string | null = meta.license?.spdx_id ?? null;
  if (!isOsiLicense(license)) return drop("licence " + license); // cheap filter before any clone
  const root: any[] = await ghOr([`repos/${name}/contents`], []);
  const files = Array.isArray(root) ? root.map((f) => f.name as string) : [];
  let pkg: string | undefined;
  if (files.includes("package.json")) {
    const f = await ghOr([`repos/${name}/contents/package.json`], null);
    if (f?.content) pkg = Buffer.from(f.content, "base64").toString("utf8");
  }
  const test_command = detectTestCommand(files, pkg);
  if (!test_command) return drop("no test command");

  const dir = join(".roster", "corpus-cache", name.replace("/", "__"));
  const fetchErr = await fetchBranchTip(meta.clone_url, dir, timeoutMs);
  if (fetchErr) return drop("checkpoint fetch failed (" + fetchErr + ")");
  const sessions = parseCheckpoints(dir, "auto", { warn: () => {} });
  const setups = new Set(sessions.map((s) => s.harness + "|" + s.model));
  return {
    repo: name,
    url: meta.html_url,
    stars: meta.stargazers_count ?? 0,
    language: meta.language ?? null,
    license,
    sessions: sessions.length,
    distinct_setups: setups.size,
    harnesses: [...new Set(sessions.map((s) => s.harness))].sort(),
    models: [...new Set(sessions.map((s) => s.model))].sort(),
    test_command,
    score: 0,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (k: string, d: string) => (argv.includes(k) ? (argv[argv.indexOf(k) + 1] ?? d) : d);
  const logPath = opt("--log", join(".roster", "corpus-find.log"));
  mkdirSync(dirname(logPath), { recursive: true });
  const log = (m: string) => {
    console.error(m);
    appendFileSync(logPath, new Date().toISOString() + " " + m + "\n");
  };

  if (argv.includes("--record")) {
    const to = new Date();
    const res = await gh(searchArgs(day(new Date(to.getTime() - 864e5)), day(to), 1));
    const redacted = redactSearchPage({ ...res, items: res.items.slice(0, 10) });
    const path = opt("--out", "reports/corpus/sample-search.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(redacted, null, 2) + "\n");
    log("wrote " + path);
    return;
  }

  const groups = groupByRepo(await searchWindows(Number(opt("--windows", "10")), log));
  log(`[search] ${groups.size} repos with checkpoint trailers`);
  const ordered = [...groups].sort((a, b) => b[1].checkpoints.length - a[1].checkpoints.length);
  const found: Candidate[] = [];
  const out = opt("--out", "reports/corpus/candidates.json");
  mkdirSync(dirname(out), { recursive: true });
  const deadline = Date.now() + Number(opt("--budget-min", "40")) * 60_000;
  const queue = ordered.slice(0, Number(opt("--max-repos", "40")));
  const worker = async () => {
    for (let item = queue.shift(); item && Date.now() < deadline; item = queue.shift()) {
      const [name] = item;
      try {
        const c = await inspect(name, Number(opt("--repo-timeout", "60")) * 1000, log);
        if (c) {
          found.push(c);
          log(`[ok] ${name}: ${c.sessions} sessions, ${c.distinct_setups} setups`);
          writeFileSync(out, JSON.stringify(rankCandidates(found), null, 2) + "\n"); // incremental
        }
      } catch (e) {
        log(`[skip] ${name}: ${(e as Error).message.slice(0, 120)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Number(opt("--concurrency", "6")) }, worker));
  const ranked = rankCandidates(found);
  writeFileSync(out, JSON.stringify(ranked, null, 2) + "\n");
  log(`wrote ${ranked.length} candidates to ${out}`);
}

if (import.meta.main) await main();
