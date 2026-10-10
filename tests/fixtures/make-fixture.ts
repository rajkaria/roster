// Builds a small git repo whose `entire/checkpoints/v1` branch has the layout of real Entire
// checkpoints (DESIGN.md §"Entire checkpoint format"). Every JSON payload is a clone of a
// redacted real sample in tests/fixtures/samples/ with values overridden; no keys are invented.
//
//   bun tests/fixtures/make-fixture.ts <outDir> [--scenario basic|confound|revert|multisession] [--force]
//
// Ground truth (commit kinds, checkpoint → sessions → setup) is printed as JSON on stdout and
// saved to <outDir>/.git/roster-fixture.json. The output is deterministic: fixed author, dates and ids.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SCENARIOS = ["basic", "confound", "revert", "multisession"] as const;
export type Scenario = (typeof SCENARIOS)[number];
export type SetupKey = "X" | "Y" | "Z";

export const CHECKPOINT_BRANCH = "entire/checkpoints/v1";
export const SAMPLES_DIR = join(import.meta.dir, "samples");
const TRUTH_FILE = "roster-fixture.json";
const AUTHOR = { name: "Roster Fixture", email: "fixture@roster.invalid" };
const BASE_TIME = Date.parse("2026-09-01T09:00:00Z");
const STEP_MS = 24 * 3600 * 1000;

const readSample = (name: string) => readFileSync(join(SAMPLES_DIR, name), "utf8");
const sampleJson = (name: string) => JSON.parse(readSample(name));
const sampleJsonl = (name: string) =>
  readSample(name)
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const clone = <T>(v: T): T => structuredClone(v);

/** sha256 of a rules file normalised per DESIGN.md: LF line endings, trimmed. */
export const rulesHash = (text: string) => sha256(text.replace(/\r\n?/g, "\n").trim());

const DEFAULT_RULES = "# Fixture rules\n\n- Write tests for what you build.\n";
const STRICT_RULES = DEFAULT_RULES + "- Run the full test suite before you finish.\n- Never modify existing tests.\n";
const AGENTS_RULES = "# Fixture agent rules\n\n- Keep changes small.\n";

interface SetupDef {
  agent: "Claude Code" | "Codex";
  model: string;
  /** Value written to metadata.json `model`; "" forces the transcript fallback, as in real data. */
  metadataModel: string;
  rulesPath: "CLAUDE.md" | "AGENTS.md";
  rules: string;
  identity?: { modelId: string; marketingName: string };
}

/** Three fake setups: different model and different rules file. */
export const SETUPS: Record<SetupKey, SetupDef> = {
  X: {
    agent: "Claude Code",
    model: "claude-opus-5-5",
    metadataModel: "claude-opus-5-5",
    rulesPath: "CLAUDE.md",
    rules: DEFAULT_RULES,
    identity: { modelId: "claude-opus-5-5[1m]", marketingName: "Opus 5.5 (1M context)" },
  },
  Y: {
    agent: "Claude Code",
    model: "claude-sonnet-5-5",
    metadataModel: "",
    rulesPath: "CLAUDE.md",
    rules: STRICT_RULES,
    identity: { modelId: "claude-sonnet-5-5", marketingName: "Sonnet 5.5" },
  },
  Z: {
    agent: "Codex",
    model: "gpt-6-astra",
    metadataModel: "",
    rulesPath: "AGENTS.md",
    rules: AGENTS_RULES,
  },
};

// ---------- plan ----------

interface SessionSpec {
  setup: SetupKey;
  /** Same key ⇒ same session_id: a session recurring across checkpoints. */
  key: string;
  prompts: string[];
}
interface FileSpec {
  path: string;
  lines: number;
}
type Step =
  | { kind: "init" }
  | { kind: "agent"; subject: string; sessions: SessionSpec[]; files: FileSpec[] }
  /** A checkpoint that no commit links to (session kept with commit_sha = null). */
  | { kind: "orphan-checkpoint"; sessions: SessionSpec[]; files: FileSpec[] }
  | { kind: "revert"; target: number }
  /** Human commit (no trailer) that rewrites some agent-added lines of the target step. */
  | { kind: "rework"; target: number; lines: number }
  /** Human commit that deletes ≥ 50% of the target's added lines without a revert message. */
  | { kind: "delete"; target: number }
  | { kind: "human"; subject: string; path: string };

const sess = (setup: SetupKey, key: string, ...prompts: string[]): SessionSpec => ({
  setup,
  key,
  prompts: prompts.map((p, i) => (i === 0 ? `[roster setup=${setup} task=${key}] ${p}` : p)),
});
const humanTail = (n: number): Step[] =>
  Array.from({ length: n }, (_, i) => ({
    kind: "human" as const,
    subject: `human: notes ${i + 1}`,
    path: `docs/notes-${i + 1}.md`,
  }));

function basicPlan(): Step[] {
  return [
    { kind: "init" },
    { kind: "agent", subject: "add alpha", sessions: [sess("X", "x1", "Add the alpha module.")], files: [{ path: "src/alpha.ts", lines: 30 }] },
    { kind: "agent", subject: "add beta", sessions: [sess("Y", "y1", "Add the beta module.", "yes")], files: [{ path: "src/beta.ts", lines: 20 }] },
    { kind: "agent", subject: "add gamma", sessions: [sess("Z", "z1", "Add the gamma module.")], files: [{ path: "src/gamma.ts", lines: 25 }] },
    { kind: "revert", target: 3 },
    {
      kind: "agent",
      subject: "add delta",
      sessions: [sess("X", "x1", "Now add the delta module."), sess("Y", "y2", "Add tests for delta.")],
      files: [{ path: "src/delta.ts", lines: 15 }],
    },
    { kind: "rework", target: 1, lines: 10 },
    ...humanTail(5),
  ];
}

function revertPlan(): Step[] {
  const steps = basicPlan();
  steps[7] = { kind: "delete", target: 2 };
  return steps;
}

function multisessionPlan(): Step[] {
  const steps = basicPlan().slice(0, 7);
  const delta = steps[5];
  if (delta?.kind === "agent") delta.sessions.push(sess("Z", "z2", "Review delta."));
  steps.push(
    { kind: "orphan-checkpoint", sessions: [sess("Y", "y3", "Explore the repo, no commit.")], files: [{ path: "src/scratch.ts", lines: 5 }] },
    { kind: "agent", subject: "add epsilon", sessions: [sess("X", "x1", "Finally add epsilon.")], files: [{ path: "src/epsilon.ts", lines: 12 }] },
    ...humanTail(5),
  );
  return steps;
}

/** Setup X gets only large changes; Y and Z get small, medium and large ones. Reverts depend on size only. */
function confoundPlan(): Step[] {
  type Size = "small" | "medium" | "large";
  const queues: Record<SetupKey, Size[]> = {
    X: Array(9).fill("large"),
    Y: ["small", "medium", "large", "small", "medium", "large", "small", "medium", "large"],
    Z: ["small", "medium", "large", "small", "medium", "large", "small", "medium", "large"],
  };
  const steps: Step[] = [{ kind: "init" }];
  let large = 0;
  for (let round = 0; round < 9; round++) {
    for (const setup of ["X", "Y", "Z"] as const) {
      const size = queues[setup][round]!;
      const name = `${setup.toLowerCase()}${round + 1}`;
      const nFiles = size === "large" ? 3 : size === "medium" ? 2 : 1;
      const lines = size === "large" ? 60 + ((round * 7) % 40) : size === "medium" ? 15 + round : 3 + (round % 4);
      const prompt =
        size === "large"
          ? `Implement the ${name} feature across ${nFiles} modules, with validation, error handling and tests for every path.`
          : `Add ${name}.`;
      steps.push({
        kind: "agent",
        subject: `add ${name}`,
        sessions: [sess(setup, name, prompt)],
        files: Array.from({ length: nFiles }, (_, f) => ({ path: `src/${name}/part${f + 1}.ts`, lines })),
      });
      if (size === "large" && large++ % 2 === 0) steps.push({ kind: "revert", target: steps.length - 1 });
    }
  }
  steps.push(...humanTail(6));
  return steps;
}

export function plan(scenario: Scenario): Step[] {
  switch (scenario) {
    case "basic":
      return basicPlan();
    case "revert":
      return revertPlan();
    case "multisession":
      return multisessionPlan();
    case "confound":
      return confoundPlan();
  }
}

// ---------- ground truth ----------

export interface TruthCommit {
  sha: string;
  kind: Step["kind"];
  subject: string;
  checkpoint_id: string | null;
  /** For revert / rework / delete: the agent commit acted on. */
  target_sha: string | null;
  date: string;
}
export interface TruthSession {
  session_id: string;
  setup: SetupKey;
  index: number;
}
export interface TruthCheckpoint {
  id: string;
  commit_sha: string | null;
  sessions: TruthSession[];
  files: string[];
}
export interface FixtureTruth {
  scenario: Scenario;
  head: string;
  checkpoint_branch_head: string;
  setups: Record<SetupKey, { agent: string; model: string; rules_path: string; rules_hash: string }>;
  commits: TruthCommit[];
  checkpoints: TruthCheckpoint[];
}

// ---------- git ----------

function gitEnv(at?: number): Record<string, string> {
  const date = at === undefined ? undefined : new Date(at).toISOString();
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TZ: "UTC",
    LANG: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: AUTHOR.name,
    GIT_AUTHOR_EMAIL: AUTHOR.email,
    GIT_COMMITTER_NAME: AUTHOR.name,
    GIT_COMMITTER_EMAIL: AUTHOR.email,
    ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
  };
}

export function git(cwd: string, args: string[], opts: { input?: string; env?: Record<string, string> } = {}): string {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...gitEnv(), ...opts.env },
    stdin: opts.input === undefined ? "ignore" : new TextEncoder().encode(opts.input),
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

// ---------- checkpoint payloads (cloned from samples) ----------

interface Usage {
  input_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  api_call_count: number;
}

function uuidFrom(seed: string): string {
  const h = sha256(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Per-call usage, deterministic from the seed. */
function callUsages(seed: string, calls: number) {
  return Array.from({ length: calls }, (_, i) => {
    const n = parseInt(sha256(`${seed}:${i}`).slice(0, 6), 16);
    return {
      input_tokens: 2 + (n % 13),
      cache_creation_input_tokens: 1000 + (n % 4000),
      cache_read_input_tokens: 20000 + (n % 30000),
      output_tokens: 200 + (n % 2500),
    };
  });
}

function claudeTranscript(setup: SetupDef, sessionId: string, at: number, seed: string, calls: number) {
  const [instr, model, assistant] = sampleJsonl("claude-code-full.jsonl");
  instr.attachment.files[0].content = setup.rules;
  instr.attachment.files[0].path = `<repo>/${setup.rulesPath}`;
  model.attachment.identity = { ...model.attachment.identity, ...setup.identity };
  const usages = callUsages(seed, calls);
  const lines = usages.map((u, i) => {
    const a = clone(assistant);
    a.sessionId = sessionId;
    a.timestamp = new Date(at - (calls - i) * 60_000).toISOString();
    a.message.model = setup.model;
    a.message.usage = { ...a.message.usage, ...u };
    return a;
  });
  const usage: Usage = {
    input_tokens: usages.reduce((s, u) => s + u.input_tokens, 0),
    cache_creation_tokens: usages.reduce((s, u) => s + u.cache_creation_input_tokens, 0),
    cache_read_tokens: usages.reduce((s, u) => s + u.cache_read_input_tokens, 0),
    output_tokens: usages.reduce((s, u) => s + u.output_tokens, 0),
    api_call_count: calls,
  };
  return { jsonl: [instr, model, ...lines], usage };
}

function codexTranscript(setup: SetupDef, seed: string, calls: number) {
  const [turn, tokens] = sampleJsonl("codex-full.jsonl");
  turn.payload.model = setup.model;
  turn.payload.turn_id = sha256(`turn:${seed}`).slice(0, 12);
  const u = callUsages(seed, calls);
  const cached = u.reduce((s, x) => s + x.cache_read_input_tokens, 0);
  const fresh = u.reduce((s, x) => s + x.input_tokens + x.cache_creation_input_tokens, 0);
  const output = u.reduce((s, x) => s + x.output_tokens, 0);
  const reasoning = Math.floor(output / 5);
  tokens.payload.info.total_token_usage = {
    ...tokens.payload.info.total_token_usage,
    input_tokens: fresh + cached,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: fresh + cached + output,
  };
  // metadata input_tokens excludes cached input, as in the real sample (743941 − 676480 = 67461).
  const usage: Usage = { input_tokens: fresh, cache_creation_tokens: 0, cache_read_tokens: cached, output_tokens: output, api_call_count: calls };
  return { jsonl: [turn, tokens], usage };
}

interface BuiltSession {
  files: Record<string, string>;
  usage: Usage;
  truth: TruthSession;
}

function buildSession(
  scenario: Scenario,
  checkpointId: string,
  index: number,
  spec: SessionSpec,
  at: number,
  touched: string[],
  agentLines: number,
): BuiltSession {
  const setup = SETUPS[spec.setup];
  const sessionId = uuidFrom(`${scenario}:session:${spec.key}`);
  const seed = `${scenario}:${checkpointId}:${index}`;
  const calls = 3 + (parseInt(sha256(seed).slice(0, 4), 16) % 6);
  const created = new Date(at).toISOString();

  let transcript: { jsonl: unknown[]; usage: Usage };
  let meta: Record<string, unknown>;
  if (setup.agent === "Claude Code") {
    transcript = claudeTranscript(setup, sessionId, at, seed, calls);
    meta = sampleJson("session-metadata-claude-code.json");
    meta.branch = "main";
    meta.turn_id = sha256(`turn:${seed}`).slice(0, 12);
    meta.session_metrics = { turn_count: spec.prompts.length };
    meta.initial_attribution = {
      calculated_at: created,
      agent_lines: agentLines,
      human_added: 0,
      human_modified: 0,
      human_removed: 0,
      total_committed: agentLines,
      agent_percentage: agentLines > 0 ? 100 : 0,
    };
  } else {
    transcript = codexTranscript(setup, seed, calls);
    meta = sampleJson("session-metadata-codex.json");
    meta.compact_transcript_start = 0;
  }
  Object.assign(meta, {
    checkpoint_id: checkpointId,
    session_id: sessionId,
    strategy: "manual-commit",
    created_at: created,
    files_touched: touched,
    agent: setup.agent,
    model: setup.metadataModel,
    token_usage: transcript.usage,
  });

  const full = transcript.jsonl.map((l) => JSON.stringify(l)).join("\n") + "\n";
  return {
    files: {
      "metadata.json": JSON.stringify(meta, null, 2) + "\n",
      "full.jsonl": full,
      "content_hash.txt": `sha256:${sha256(full)}\n`,
      "prompt.txt": spec.prompts.join("\n\n---\n\n") + "\n",
    },
    usage: transcript.usage,
    truth: { session_id: sessionId, setup: spec.setup, index },
  };
}

function buildRootMetadata(checkpointId: string, touched: string[], sessions: BuiltSession[]): string {
  const root = sampleJson("branch-root-metadata.json");
  const base = `/${checkpointId.slice(0, 2)}/${checkpointId.slice(2)}`;
  const [entryShape] = root.sessions;
  const keys = Object.keys(entryShape) as (keyof typeof NAMES)[];
  root.checkpoint_id = checkpointId;
  root.strategy = "manual-commit";
  root.branch = "main";
  root.files_touched = touched;
  root.sessions = sessions.map((_, n) => Object.fromEntries(keys.map((k) => [k, `${base}/${n}/${NAMES[k]}`])));
  const sum = (k: keyof Usage) => sessions.reduce((s, x) => s + x.usage[k], 0);
  root.token_usage = {
    input_tokens: sum("input_tokens"),
    cache_creation_tokens: sum("cache_creation_tokens"),
    cache_read_tokens: sum("cache_read_tokens"),
    output_tokens: sum("output_tokens"),
    api_call_count: sum("api_call_count"),
  };
  return JSON.stringify(root, null, 2) + "\n";
}
/** Root `sessions[]` entry key → file name inside `<n>/`. */
const NAMES = { metadata: "metadata.json", transcript: "full.jsonl", content_hash: "content_hash.txt", prompt: "prompt.txt" } as const;

/** Appends one checkpoint to the cumulative `entire/checkpoints/v1` tree. */
class CheckpointBranch {
  private index: string;
  private head: string | null = null;
  constructor(private repo: string) {
    this.index = join(repo, ".git", "roster-checkpoints.index");
  }
  write(checkpointId: string, files: Record<string, string>, message: string, at: number) {
    const env = { GIT_INDEX_FILE: this.index };
    const base = `${checkpointId.slice(0, 2)}/${checkpointId.slice(2)}`;
    for (const [rel, content] of Object.entries(files)) {
      const blob = git(this.repo, ["hash-object", "-w", "--stdin"], { input: content });
      git(this.repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},${base}/${rel}`], { env });
    }
    const tree = git(this.repo, ["write-tree"], { env });
    const parents = this.head ? ["-p", this.head] : [];
    this.head = git(this.repo, ["commit-tree", tree, ...parents, "-F", "-"], { input: message, env: gitEnv(at) });
    git(this.repo, ["update-ref", `refs/heads/${CHECKPOINT_BRANCH}`, this.head]);
    return this.head;
  }
  finish() {
    rmSync(this.index, { force: true });
    return this.head ?? "";
  }
}

// ---------- repo content ----------

const ident = (path: string) => path.replace(/^src\//, "").replace(/\.ts$/, "").replace(/[^a-zA-Z0-9]/g, "_");
const codeLines = (path: string, n: number) => Array.from({ length: n }, (_, i) => `export const ${ident(path)}_${i} = ${i};`);

function writeRepoFile(repo: string, rel: string, content: string) {
  const p = join(repo, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

// ---------- build ----------

export function makeFixture(outDir: string, scenario: Scenario = "basic", opts: { force?: boolean } = {}): FixtureTruth {
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    const ours = existsSync(join(outDir, ".git", TRUTH_FILE));
    if (!ours && !opts.force) throw new Error(`${outDir} is not empty and is not a previous fixture; pass --force to overwrite`);
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });
  const repo = outDir;
  git(repo, ["init", "-q", "-b", "main"]);

  const steps = plan(scenario);
  const branch = new CheckpointBranch(repo);
  const commits: TruthCommit[] = [];
  const checkpoints: TruthCheckpoint[] = [];
  const stepSha: (string | null)[] = [];
  const stepFiles: FileSpec[][] = [];
  let checkpointSeq = 0;

  const commit = (at: number, message: string) => {
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "--no-gpg-sign", "-F", "-"], { input: message, env: gitEnv(at) });
    return git(repo, ["rev-parse", "HEAD"]);
  };
  const record = (sha: string, step: Step, subject: string, at: number, checkpointId: string | null, target: number | null) =>
    commits.push({
      sha,
      kind: step.kind,
      subject,
      checkpoint_id: checkpointId,
      target_sha: target === null ? null : stepSha[target] ?? null,
      date: new Date(at).toISOString(),
    });

  const nextCheckpointId = () => sha256(`${scenario}:checkpoint:${checkpointSeq++}`).slice(0, 12);
  const checkpoint = (id: string, sessions: SessionSpec[], files: FileSpec[], at: number, commitSha: string | null) => {
    const touched = files.map((f) => f.path);
    const agentLines = files.reduce((s, f) => s + f.lines, 0);
    const built = sessions.map((s, n) => buildSession(scenario, id, n, s, at, touched, agentLines));
    const tree: Record<string, string> = { "metadata.json": buildRootMetadata(id, touched, built) };
    built.forEach((b, n) => {
      for (const [name, content] of Object.entries(b.files)) tree[`${n}/${name}`] = content;
    });
    // Commit message follows the real refs-backend sample: `Checkpoint:` then Entire-* trailers.
    const first = built[0]!;
    const message = readSample("refs-commit-message.txt")
      .replace(/^Checkpoint: .*$/m, `Checkpoint: ${id}`)
      .replace(/^Entire-Session: .*$/m, `Entire-Session: ${first.truth.session_id}`)
      .replace(/^Entire-Strategy: .*$/m, "Entire-Strategy: manual-commit")
      .replace(/^Entire-Agent: .*$/m, `Entire-Agent: ${SETUPS[first.truth.setup].agent}`);
    branch.write(id, tree, message, at);
    checkpoints.push({ id, commit_sha: commitSha, sessions: built.map((b) => b.truth), files: touched });
  };

  steps.forEach((step, i) => {
    const at = BASE_TIME + i * STEP_MS;
    stepFiles[i] = [];
    switch (step.kind) {
      case "init": {
        writeRepoFile(repo, "README.md", "# fixture\n\nA test repo built by tests/fixtures/make-fixture.ts.\n");
        writeRepoFile(repo, "CLAUDE.md", DEFAULT_RULES);
        writeRepoFile(repo, "AGENTS.md", AGENTS_RULES);
        writeRepoFile(repo, "src/index.ts", "export {};\n");
        const sha = commit(at, "init\n");
        stepSha[i] = sha;
        record(sha, step, "init", at, null, null);
        break;
      }
      case "agent": {
        for (const f of step.files) writeRepoFile(repo, f.path, codeLines(f.path, f.lines).join("\n") + "\n");
        stepFiles[i] = step.files;
        // Entire writes the checkpoint at commit time; the trailer id is known before the commit.
        const id = nextCheckpointId();
        const sha = commit(at, `${step.subject}\n\nEntire-Checkpoint: ${id}\n`);
        checkpoint(id, step.sessions, step.files, at, sha);
        stepSha[i] = sha;
        record(sha, step, step.subject, at, id, null);
        break;
      }
      case "orphan-checkpoint": {
        checkpoint(nextCheckpointId(), step.sessions, step.files, at, null);
        stepSha[i] = null;
        break;
      }
      case "revert": {
        const target = stepSha[step.target];
        if (!target) throw new Error(`revert target ${step.target} has no commit`);
        git(repo, ["revert", "--no-edit", "--no-gpg-sign", target], { env: gitEnv(at) });
        const sha = git(repo, ["rev-parse", "HEAD"]);
        stepSha[i] = sha;
        record(sha, step, git(repo, ["log", "-1", "--format=%s"]), at, null, step.target);
        break;
      }
      case "rework": {
        const f = stepFiles[step.target]?.[0];
        if (!f) throw new Error(`rework target ${step.target} has no files`);
        const lines = readFileSync(join(repo, f.path), "utf8").split("\n");
        for (let k = 0; k < step.lines && k < f.lines; k++) lines[k] = `export const ${ident(f.path)}_${k} = ${k} * 2; // reworked`;
        writeRepoFile(repo, f.path, lines.join("\n"));
        const subject = `human: rework ${f.path}`;
        const sha = commit(at, subject + "\n");
        stepSha[i] = sha;
        record(sha, step, subject, at, null, step.target);
        break;
      }
      case "delete": {
        const f = stepFiles[step.target]?.[0];
        if (!f) throw new Error(`delete target ${step.target} has no files`);
        const keep = Math.floor(f.lines * 0.4);
        writeRepoFile(repo, f.path, codeLines(f.path, f.lines).slice(f.lines - keep).join("\n") + "\n");
        const subject = `human: trim ${f.path}`;
        const sha = commit(at, subject + "\n");
        stepSha[i] = sha;
        record(sha, step, subject, at, null, step.target);
        break;
      }
      case "human": {
        writeRepoFile(repo, step.path, `# ${step.subject}\n`);
        const sha = commit(at, step.subject + "\n");
        stepSha[i] = sha;
        record(sha, step, step.subject, at, null, null);
        break;
      }
    }
  });

  const truth: FixtureTruth = {
    scenario,
    head: git(repo, ["rev-parse", "HEAD"]),
    checkpoint_branch_head: branch.finish(),
    setups: Object.fromEntries(
      (Object.keys(SETUPS) as SetupKey[]).map((k) => {
        const s = SETUPS[k];
        return [k, { agent: s.agent, model: s.model, rules_path: s.rulesPath, rules_hash: rulesHash(s.rules) }];
      }),
    ) as FixtureTruth["setups"],
    commits,
    checkpoints,
  };
  writeFileSync(join(repo, ".git", TRUTH_FILE), JSON.stringify(truth, null, 2) + "\n");
  return truth;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outDir = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--scenario");
  const si = args.indexOf("--scenario");
  const scenario = (si >= 0 ? args[si + 1] : "basic") as Scenario;
  if (!outDir || !SCENARIOS.includes(scenario)) {
    console.error(`usage: bun tests/fixtures/make-fixture.ts <outDir> [--scenario ${SCENARIOS.join("|")}] [--force]`);
    process.exit(2);
  }
  console.log(JSON.stringify(makeFixture(outDir, scenario, { force: args.includes("--force") }), null, 2));
}
