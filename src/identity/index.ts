// Setup identity: harness + model + rules hash, plus ground truth from the prompt tag.
// See docs/DESIGN.md §"Setups" and §"Recovering the model and the rules file from transcripts".
import { createHash } from "node:crypto";

/**
 * The session fields identity needs. `ParsedSession` from src/ingest/parse.ts satisfies it.
 * `rules_hash` is the transcript-derived hash (Claude `instructions` attachments, Codex `agents_md`),
 * or null when the transcript records no rules file.
 */
export interface IdentitySource {
  /** Agent display name as Entire records it, e.g. "Claude Code" or "Codex". */
  harness: string;
  /** Resolved model, or "unknown" when neither metadata nor transcript records it. */
  model: string;
  rules_hash: string | null;
  /** The commit that carries this session's checkpoint trailer, or null. */
  commit_sha: string | null;
  first_prompt: string;
}

/** Ground truth written by the self-build protocol: `[roster setup=<id> task=<Txx>]`. */
export interface SetupTag {
  setup: string;
  task: string;
}

export interface Identity {
  /** Short hash of (harness, model, rulesHash); null when the rules are unknown. */
  setupId: string | null;
  /** Normalised harness id, e.g. "claude-code", "codex". */
  harness: string;
  model: string;
  rulesHash: string | null;
  rulesPath: string | null;
  tag: SetupTag | null;
}

const TAG_RE = /^\s*\[roster setup=([^\s\]]+) task=([^\s\]]+)\]/;

/** Rules files in effect for each harness, matched against the files tracked at the parent commit. */
const RULES_FILES: Record<string, (tracked: string[]) => string[]> = {
  "claude-code": (t) => t.filter((p) => p === "CLAUDE.md"),
  codex: (t) => t.filter((p) => p === "AGENTS.md"),
  cursor: (t) => t.filter((p) => p === ".cursorrules" || p.startsWith(".cursor/rules/")).sort(),
};

/** Default rules path recorded when the transcript carries the rules text itself. */
const DEFAULT_RULES_PATH: Record<string, string> = {
  "claude-code": "CLAUDE.md",
  codex: "AGENTS.md",
};

/** "Claude Code" → "claude-code", "Factory AI Droid" → "factory-ai-droid". */
export function harnessId(agent: string): string {
  return agent
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Normalised per DESIGN.md: LF line endings, trimmed. */
const normalise = (text: string) => text.replace(/\r\n?/g, "\n").trim();
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Short setup id, or null when the rules hash is unknown (never a guess). */
export function setupIdOf(harness: string, model: string, rulesHash: string | null): string | null {
  if (rulesHash === null) return null;
  return sha256([harness, model, rulesHash].join("\n")).slice(0, 12);
}

/** Parses `[roster setup=X task=Txx]` at the start of the first prompt. */
export function parseTag(firstPrompt: string): SetupTag | null {
  const m = TAG_RE.exec(firstPrompt);
  return m ? { setup: m[1]!, task: m[2]! } : null;
}

function git(repo: string, args: string[]): string | null {
  const p = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  return p.exitCode === 0 ? p.stdout.toString() : null;
}

/**
 * Rules in effect at a commit's parent: the file contents as they stood before the session's
 * first linked commit. Null when the commit or its parent is unknown, or no rules file exists.
 */
function rulesAtParent(harness: string, repo: string, commitSha: string | null): { rulesHash: string; rulesPath: string } | null {
  const rules = RULES_FILES[harness];
  if (!rules || !commitSha) return null;
  const parent = git(repo, ["rev-parse", "--verify", "-q", `${commitSha}^`])?.trim();
  if (!parent) return null;
  const tracked = git(repo, ["ls-tree", "-r", "--name-only", parent])?.split("\n").filter(Boolean) ?? [];
  const paths = rules(tracked);
  if (paths.length === 0) return null;
  const texts: string[] = [];
  for (const p of paths) {
    const text = git(repo, ["show", `${parent}:${p}`]);
    if (text === null) return null;
    texts.push(normalise(text));
  }
  return { rulesHash: sha256(texts.join("\n")), rulesPath: paths.join(",") };
}

/**
 * Setup of one session. The rules hash comes from the transcript when it records one, otherwise
 * from the rules file at the parent of the session's commit. Anything unknown is null.
 */
export function identify(session: IdentitySource, repoPath: string): Identity {
  const harness = harnessId(session.harness);
  const model = session.model || "unknown";
  let rulesHash = session.rules_hash;
  let rulesPath: string | null = null;
  if (rulesHash !== null) {
    rulesPath = DEFAULT_RULES_PATH[harness] ?? null;
  } else {
    const found = rulesAtParent(harness, repoPath, session.commit_sha);
    if (found) ({ rulesHash, rulesPath } = found);
  }
  return {
    setupId: setupIdOf(harness, model, rulesHash),
    harness,
    model,
    rulesHash,
    rulesPath,
    tag: parseTag(session.first_prompt),
  };
}

/**
 * Share of tagged sessions whose inferred setup maps 1:1 to its tag. Each inferred setup id is
 * matched to the tag it most often carries, and each tag to the id it most often gets; a session
 * counts when both majorities agree with it. Untagged sessions are excluded. Null when nothing is tagged.
 */
export function inferenceAccuracy(sessions: ReadonlyArray<Pick<Identity, "setupId" | "tag">>): number | null {
  const tagged = sessions.filter((s): s is { setupId: string | null; tag: SetupTag } => s.tag !== null);
  if (tagged.length === 0) return null;
  const tagsById = new Map<string, Map<string, number>>();
  const idsByTag = new Map<string, Map<string, number>>();
  const bump = (outer: Map<string, Map<string, number>>, k: string, inner: string) => {
    const m = outer.get(k) ?? new Map<string, number>();
    m.set(inner, (m.get(inner) ?? 0) + 1);
    outer.set(k, m);
  };
  for (const s of tagged) {
    if (s.setupId === null) continue;
    bump(tagsById, s.setupId, s.tag.setup);
    bump(idsByTag, s.tag.setup, s.setupId);
  }
  // A tie means no single mapping, so it counts as no match.
  const majority = (m: Map<string, number> | undefined) => {
    let best: string | null = null;
    let n = 0;
    let tied = false;
    for (const [k, v] of m ?? []) {
      if (v > n) {
        best = k;
        n = v;
        tied = false;
      } else if (v === n) tied = true;
    }
    return tied ? null : best;
  };
  const ok = tagged.filter(
    (s) =>
      s.setupId !== null &&
      majority(tagsById.get(s.setupId)) === s.tag.setup &&
      majority(idsByTag.get(s.tag.setup)) === s.setupId,
  ).length;
  return ok / tagged.length;
}
