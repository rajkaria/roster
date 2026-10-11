// Planted-bug history for attribution checks (forward task F10).
//
// Copies a repo (`git clone --no-local`) and rewrites chosen commits so that one comparison
// operator on a line the commit added is flipped, then adds a "fix: …" commit right after it that
// restores the operator. The answer key — which copy commit carries which bug, where, and which
// copy commit fixes it — is written outside the copy. A commit that added no editable comparison
// line is left alone and listed under `skipped` in the key instead.
//
// The copy is built by replaying history as raw commit objects, without checking anything out, so
// a commit whose ancestors are unmodified keeps its original id (the object written back is the
// object that was read) and only a rewritten suffix gets new ids. The line and the replacement
// operator come from a PRNG seeded with `seed`, so the same repo and seed produce the same copy.
//
//   bun scripts/planted/plant.ts --source <repo> --out <dir> --key <file.json> [--seed N] [--commit <sha>]...
//
// A "comparison operator" is one of `<`, `>`, `<=`, `>=`, `==`, `!=` found outside string
// literals and trailing `//` comments. That is a heuristic, not a parser: code where `<`/`>` also
// mean generics, templates or shell redirection can pick a line that is not a comparison.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/** The empty tree object git understands in every repo; the left side of a root commit's diff. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Replacements for each operator, never including the operator itself. */
const FLIPS: Record<string, readonly string[]> = {
  "<": [">", "<=", ">=", "==", "!="],
  ">": ["<", "<=", ">=", "==", "!="],
  "<=": ["<", ">", ">=", "==", "!="],
  ">=": ["<", ">", "<=", "==", "!="],
  "==": ["<", ">", "<=", ">=", "!="],
  "!=": ["<", ">", "<=", ">=", "=="],
};

const OPERATORS = ["<=", ">=", "==", "!=", "<", ">"] as const;

export interface PlantOptions {
  /** Repo to copy. Never written to. */
  sourceRepo: string;
  /** Where the copy goes; must not exist, or must be an empty directory. */
  outDir: string;
  /** Answer key path. Must be outside `outDir`. */
  keyPath: string;
  /** Source commit ids (any revision syntax `git rev-parse` accepts) to plant into. */
  commits: string[];
  seed: number;
}

export interface PlantedBug {
  /** Commit in the copy that carries the flipped operator. */
  commit: string;
  /** The source commit it was rewritten from. */
  sourceCommit: string;
  file: string;
  /** 1-based line of the flipped operator in that file at `commit`. */
  line: number;
  /** The operator the source commit wrote. */
  originalOperator: string;
  /** The operator the copy has instead. */
  operator: string;
  /** Commit in the copy that restores `originalOperator`. */
  fixCommit: string;
  fixMessage: string;
}

export interface SkippedCommit {
  /** The commit's id in the copy, or null when it is not in the copied history. */
  commit: string | null;
  sourceCommit: string;
  reason: string;
}

export interface AnswerKey {
  version: number;
  seed: number;
  sourceRepo: string;
  copy: string;
  sourceHead: string | null;
  copyHead: string | null;
  /** First commit whose history was replayed, i.e. the earliest listed commit. */
  replayedFrom: string | null;
  planted: PlantedBug[];
  skipped: SkippedCommit[];
}

export interface PlantResult {
  planted: PlantedBug[];
  skipped: SkippedCommit[];
  key: AnswerKey;
}

/** A commit object split into the parts a replay keeps verbatim and the parts it rewrites. */
interface RawCommit {
  tree: string;
  parents: string[];
  /** Every header line except `tree` and `parent`, in the order git wrote them. */
  headers: string[];
  /** Message bytes exactly as stored, trailing newline included. */
  message: Buffer;
}

interface Candidate {
  file: string;
  /** 1-based line in the new version of the file. */
  line: number;
  /** Character offset of the operator within that line. */
  index: number;
  operator: string;
}

interface SpawnOpts {
  stdin?: Buffer;
  env?: Record<string, string>;
}

function spawn(repo: string, args: string[], opts: SpawnOpts) {
  return Bun.spawnSync(["git", "-c", "core.quotepath=off", ...args], {
    cwd: repo,
    stdin: opts.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...opts.env },
  });
}

function git(repo: string, args: string[], opts: SpawnOpts = {}): string {
  const p = spawn(repo, args, opts);
  if (p.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${p.exitCode}): ${p.stderr.toString().trim()}`);
  }
  return p.stdout.toString();
}

function gitTry(repo: string, args: string[]): { ok: boolean; out: string } {
  const p = spawn(repo, args, {});
  return { ok: p.exitCode === 0, out: p.stdout.toString() };
}

/** mulberry32: small, seeded, and stable across runs and platforms. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Comparison operators in one added line, skipping string literals and trailing `//` comments.
 * Occurrences that only extend a longer token (`===`, `!==`, `=>`, `->`, `<<`, `>>`) are skipped.
 */
export function scanOperators(line: string): { index: number; operator: string }[] {
  const found: { index: number; operator: string }[] = [];
  const at = (i: number) => (i < 0 || i >= line.length ? "" : (line[i] as string));
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "/" && at(i + 1) === "/" && (i === 0 || /\s/.test(at(i - 1)))) break;
    const two = at(i) + at(i + 1);
    if (two === "<=" || two === ">=" || two === "==" || two === "!=") {
      // `===` and `!==` are identity checks, not the comparisons we want to flip.
      const extendsLeft = at(i - 1) === "=" || (two === "==" && at(i - 1) === "!");
      const extendsRight = at(i + 2) === "=";
      if (!extendsLeft && !extendsRight) found.push({ index: i, operator: two });
      i++;
      continue;
    }
    if (ch === "<" || ch === ">") {
      const prev = at(i - 1);
      const next = at(i + 1);
      const isPart = next === ch || next === "=" || prev === ch || prev === "=" || prev === "-" || prev === "!";
      if (!isPart) found.push({ index: i, operator: ch });
    }
  }
  return found;
}

/** Added lines of `sha` (against its first parent, or the empty tree for a root commit). */
function addedLines(repo: string, sha: string, parent: string | null): { file: string; line: number; text: string }[] {
  const args = ["diff-tree", "-r", "-m", "--first-parent", "--root", "--no-commit-id", "--name-only", "-z", "--no-renames", sha];
  const files = git(repo, args).split("\0").filter((f) => f !== "");
  const out: { file: string; line: number; text: string }[] = [];
  for (const file of files) {
    const diff = git(repo, ["diff", "--no-renames", "--unified=0", "--no-color", parent ?? EMPTY_TREE, sha, "--", file]);
    let inHunk = false;
    let newLine = 0;
    for (const raw of diff.split("\n")) {
      if (raw.startsWith("diff --git ")) {
        inHunk = false;
        continue;
      }
      if (!inHunk) {
        const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
        if (m) {
          inHunk = true;
          newLine = Number(m[1]);
        }
        continue;
      }
      if (raw.startsWith("@@")) {
        const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
        if (m) newLine = Number(m[1]);
        continue;
      }
      if (raw.startsWith("+")) {
        out.push({ file, line: newLine, text: raw.slice(1) });
        newLine++;
      } else if (raw.startsWith(" ")) {
        newLine++;
      }
    }
  }
  return out;
}

function readCommit(repo: string, sha: string): RawCommit {
  const proc = spawn(repo, ["cat-file", "commit", sha], {});
  if (proc.exitCode !== 0) throw new Error(`git cat-file commit ${sha} failed: ${proc.stderr.toString().trim()}`);
  const raw = proc.stdout;
  const text = raw.toString("utf8");
  const split = text.indexOf("\n\n");
  if (split === -1) throw new Error(`${sha} is not a well formed commit object`);
  const headers = text.slice(0, split).split("\n");
  const find = (prefix: string) => headers.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length).trim());
  return {
    tree: find("tree ")[0] ?? "",
    parents: find("parent "),
    headers: headers.filter((l) => !l.startsWith("tree ") && !l.startsWith("parent ")),
    message: raw.subarray(Buffer.byteLength(text.slice(0, split)) + 2),
  };
}

/**
 * Write a commit object built from `tree`, `parents`, verbatim `headers` (author, committer, …)
 * and raw `message` bytes. Bytes in, bytes out: an unmodified commit keeps its id, because the
 * object it writes is the object that was read.
 */
function writeCommit(repo: string, tree: string, parents: string[], headers: string[], message: Buffer): string {
  const body = [`tree ${tree}`, ...parents.map((p) => `parent ${p}`), ...headers].join("\n") + "\n\n";
  return git(repo, ["hash-object", "-t", "commit", "-w", "--stdin"], { stdin: Buffer.concat([Buffer.from(body, "utf8"), message]) }).trim();
}

/** The same headers with the committer date one second later, so the fix lands after the bug. */
function bumpCommitterDate(headers: string[]): string[] {
  return headers.map((line) => {
    if (!line.startsWith("committer ")) return line;
    const m = / (\d+) ([+-]\d{4})$/.exec(line);
    return m ? line.replace(/ (\d+) ([+-]\d{4})$/, ` ${Number(m[1]) + 1} ${m[2]}`) : line;
  });
}

let indexSeq = 0;

/** A copy of `sha`'s tree with one character of one line replaced. */
function rewriteOperator(repo: string, sha: string, hit: Candidate, operator: string): string {
  const content = git(repo, ["show", `${sha}:${hit.file}`]);
  const lines = content.split("\n");
  const line = lines[hit.line - 1];
  if (line === undefined) throw new Error(`${hit.file}: no line ${hit.line} at ${sha}`);
  if (line.slice(hit.index, hit.index + hit.operator.length) !== hit.operator) {
    throw new Error(`${hit.file}:${hit.line} at ${sha} is not "${hit.operator}"`);
  }
  lines[hit.line - 1] = line.slice(0, hit.index) + operator + line.slice(hit.index + hit.operator.length);
  const blob = git(repo, ["hash-object", "-w", "--stdin"], { stdin: Buffer.from(lines.join("\n"), "utf8") }).trim();
  const mode = git(repo, ["ls-tree", sha, "--", hit.file]).trim().split(/\s+/)[0] ?? "100644";
  const indexFile = join(tmpdir(), `roster-planted-index-${process.pid}-${indexSeq++}`);
  try {
    const env = { GIT_INDEX_FILE: indexFile };
    git(repo, ["read-tree", `${sha}^{tree}`], { env });
    git(repo, ["update-index", "--add", "--cacheinfo", `${mode},${blob},${hit.file}`], { env });
    return git(repo, ["write-tree"], { env }).trim();
  } finally {
    rmSync(indexFile, { force: true });
  }
}

/** HEAD and working-tree status of a repo, as "did anything change?" evidence. */
function snapshot(repo: string): { head: string | null; status: string } {
  const head = gitTry(repo, ["rev-parse", "--verify", "HEAD"]);
  return { head: head.ok ? head.out.trim() : null, status: git(repo, ["status", "--porcelain"]) };
}

/**
 * Copy `sourceRepo` to `outDir`, plant a flipped comparison operator in each listed commit
 * (rewriting that commit and everything after it), add a `fix:` commit restoring each one, and
 * write the answer key to `keyPath`.
 *
 * The source repo is read-only here: its HEAD and status are captured before and after and a
 * mismatch aborts the call.
 */
export async function plant(opts: PlantOptions): Promise<PlantResult> {
  const source = resolve(opts.sourceRepo);
  const out = resolve(opts.outDir);
  const keyPath = resolve(opts.keyPath);

  if (keyPath === out || keyPath.startsWith(out + sep)) {
    throw new Error(`keyPath must be outside outDir: ${keyPath} is inside ${out}`);
  }
  if (existsSync(out) && readdirSync(out).length > 0) {
    throw new Error(`outDir already exists and is not empty: ${out}`);
  }
  const before = snapshot(source);

  mkdirSync(dirname(out), { recursive: true });
  git(dirname(out), ["clone", "--no-local", source, out]);

  const headRef = gitTry(out, ["rev-parse", "--verify", "HEAD"]);
  const sourceHead = headRef.ok ? headRef.out.trim() : null;
  const order = headRef.ok ? git(out, ["rev-list", "--reverse", "--topo-order", "HEAD"]).split("\n").filter(Boolean) : [];
  const requested = resolveRequested(out, opts.commits);

  const wanted = new Set<string>();
  for (const r of requested) if (r.sha !== null) wanted.add(r.sha);
  let start = order.findIndex((sha) => wanted.has(sha));
  if (start === -1) start = order.length;

  const map = new Map<string, string>();
  const planted: PlantedBug[] = [];
  const skipped: SkippedCommit[] = [];
  const rng = mulberry32(opts.seed);
  const done = new Set<string>();

  for (let i = start; i < order.length; i++) {
    const old = order[i] as string;
    const raw = readCommit(out, old);
    const mapped = raw.parents.map((p) => map.get(p) ?? p);

    if (wanted.has(old) && !done.has(old)) {
      done.add(old);
      const parent = raw.parents[0] ?? null;
      const candidates: Candidate[] = [];
      for (const added of addedLines(out, old, parent)) {
        if (added.text.includes("\0")) continue;
        for (const op of scanOperators(added.text)) {
          candidates.push({ file: added.file, line: added.line, index: op.index, operator: op.operator });
        }
      }
      if (candidates.length === 0) {
        const sha = writeCommit(out, raw.tree, mapped, raw.headers, raw.message);
        map.set(old, sha);
        skipped.push({ commit: sha, sourceCommit: old, reason: "added no editable comparison line" });
        continue;
      }
      const hit = candidates[Math.floor(rng() * candidates.length)] as Candidate;
      const flips = FLIPS[hit.operator] as readonly string[];
      const flipped = flips[Math.floor(rng() * flips.length)] as string;
      const newTree = rewriteOperator(out, old, hit, flipped);
      const bugCommit = writeCommit(out, newTree, mapped, raw.headers, raw.message);
      const fixMessage = `fix: restore the ${hit.operator} comparison in ${hit.file}\n`;
      const fixCommit = writeCommit(out, raw.tree, [bugCommit], bumpCommitterDate(raw.headers), Buffer.from(fixMessage, "utf8"));
      map.set(old, fixCommit);
      planted.push({
        commit: bugCommit,
        sourceCommit: old,
        file: hit.file,
        line: hit.line,
        originalOperator: hit.operator,
        operator: flipped,
        fixCommit,
        fixMessage: fixMessage.trim(),
      });
      continue;
    }

    map.set(old, writeCommit(out, raw.tree, mapped, raw.headers, raw.message));
  }

  // Listed commits that were never replayed: duplicated ids, or ids not in the copied history.
  const seen = new Set<string>();
  for (const r of requested) {
    if (r.sha === null) {
      skipped.push({ commit: null, sourceCommit: r.input, reason: "not a commit in the source repo" });
      continue;
    }
    if (seen.has(r.sha)) {
      skipped.push({ commit: map.get(r.sha) ?? null, sourceCommit: r.sha, reason: "duplicate commit in the commits list" });
      continue;
    }
    seen.add(r.sha);
    if (!done.has(r.sha)) {
      skipped.push({ commit: null, sourceCommit: r.sha, reason: "commit not reachable from the copy's HEAD" });
    }
  }

  const copyHead = sourceHead === null ? null : (map.get(sourceHead) ?? sourceHead);
  if (copyHead !== null && copyHead !== sourceHead) git(out, ["reset", "--hard", copyHead]);

  const after = snapshot(source);
  if (after.head !== before.head || after.status !== before.status) {
    throw new Error(`plant modified the source repo ${source}`);
  }

  const replayedFrom = start < order.length ? (map.get(order[start] as string) ?? null) : null;
  const key: AnswerKey = {
    version: 1,
    seed: opts.seed,
    sourceRepo: source,
    copy: out,
    sourceHead,
    copyHead,
    replayedFrom,
    planted,
    skipped,
  };
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, JSON.stringify(key, null, 2) + "\n");

  return { planted, skipped, key };
}

interface Requested {
  input: string;
  sha: string | null;
}

/** Resolve each listed commit id inside the copy, keeping the caller's order and duplicates. */
function resolveRequested(repo: string, commits: string[]): Requested[] {
  return commits.map((input) => {
    const r = gitTry(repo, ["rev-parse", "--verify", "--quiet", `${input}^{commit}`]);
    return { input, sha: r.ok && r.out.trim() !== "" ? r.out.trim() : null };
  });
}

// ---------- CLI ----------

function usage(): never {
  console.error(
    "usage: bun scripts/planted/plant.ts --source <repo> --out <dir> --key <file.json> [--seed N] [--commit <sha>]...",
  );
  process.exit(2);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let sourceRepo = "";
  let outDir = "";
  let keyPath = "";
  let seed = 0;
  const commits: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[++i];
    if (value === undefined) usage();
    if (arg === "--source") sourceRepo = value;
    else if (arg === "--out") outDir = value;
    else if (arg === "--key") keyPath = value;
    else if (arg === "--seed") seed = Number(value);
    else if (arg === "--commit") commits.push(value);
    else usage();
  }
  if (!sourceRepo || !outDir || !keyPath) usage();
  const result = await plant({ sourceRepo, outDir, keyPath, commits, seed });
  console.log(
    `planted ${result.planted.length} bug(s), skipped ${result.skipped.length} commit(s); key: ${keyPath}`,
  );
  for (const p of result.planted) {
    console.log(`  ${p.file}:${p.line} ${p.originalOperator} -> ${p.operator} in ${p.commit.slice(0, 12)} (fix ${p.fixCommit.slice(0, 12)})`);
  }
}
