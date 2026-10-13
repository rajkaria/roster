# Roster: design

**Roster is an agent that runs performance reviews for a team's AI coding agents.** It reads every session the team's coding agents recorded with [Entire](https://entire.io), then works out:
- what each session cost
- whether its change survived, was reverted, or was reworked by a human

It then tests its suspicion: it replays the weakest setup's real past tasks under candidate setups, each task at the commit before it with no future history. It promotes a candidate only if nothing regresses, and opens a pull request with the change. Finally it books the team's AI workforce into its [cfo.ai](https://cfo.ai) plan. Every Roster run is traced in [neatlogs](https://neatlogs.com).

This file is the engineering contract for everyone building Roster, humans and agents. Keep to its names and shapes. If you need to change a shared shape, change `src/types.ts` minimally and say so in your PR.

---

## Overview: the loop

```
repo URL
 → Ingest   Entire checkpoints → sessions (setup, model, tokens, prompts, files, commit)
 → Score    survival · reverted · rework (human/agent) · unattended · cost            evidence level A (observational)
 → Review   difficulty-matched scorecard → "suspect: setup X" (Mantel–Haenszel OR, CI, p)
 → Plan     coordinator: stratified task sample, candidates, budget, stop rules
 → Replay   each task at its parent commit in an isolated sandbox; incumbent + candidates
 → Grade    hidden acceptance tests · suite at parent · scope guard · blind diff-judge · reruns
 → Gate     promote only if nothing regresses                                         evidence level B (controlled replay)
     └ reject → Candidates: a new rules file from the failure taxonomy → Replay
 → Act      pull request: setups/<id>.json + rules file + evidence
 → Forward  pre-registered new tasks, paired old vs new, blind grading                evidence level C (forward)
 → Book     cfo.ai: AI Workforce department + hire-vs-scale scenario, read back to verify
```

The rule: a setup is never called "worse" on level A alone. Every page prints the evidence level next to every claim.

## Setups

**Setup** = `harness` + `model` + `rules_hash` (+ `plugins_hash` when recorded).

| Part | Where it comes from |
|---|---|
| `harness` | Entire metadata |
| `model` | The **resolved** model the run reports (e.g. `modelUsage`), never the requested flag |
| `rules_hash` | sha256 of the rules file in effect at the session's parent commit, normalised (LF line endings, trimmed): `CLAUDE.md` for Claude Code, `AGENTS.md` for Codex, `.cursor/rules/*` / `.cursorrules` for Cursor. It also covers any appended system prompt the session records. If unknown, `null`; never a guess |

### The four setups building this repo
These live in `setups/`:

| Id | Harness | Model | Rules |
|---|---|---|---|
| A | Claude Code | Opus 5.5 | `setups/rules/default.md` |
| B | Claude Code | Sonnet 5.5 | default |
| C | Codex CLI (or Claude Code + Haiku 5.5, if Codex is unavailable; logged in `experiments/PREREGISTRATION.md`) | | default (as `AGENTS.md`) |
| D | Claude Code | Sonnet 5.5 | `setups/rules/strict.md` |

### Self-build protocol
This is what makes this repo a labelled dataset.
1. **Task ids and assignment.** Every build task has an id `Txx` and a seeded random setup assignment (seed `20261010`). Both are published in `experiments/PREREGISTRATION.md`.
2. **Prompt tag.** The first prompt of every session starts with `[roster setup=<id> task=<Txx>]`. Roster's own setup inference is checked against these tags.
3. **One task per worktree.** One task gets one worktree and one branch, launched by `scripts/run-setup.sh <setup> <task>` with isolated settings: `--setting-sources project --strict-mcp-config`. The project `.mcp.json` holds only Entire and neatlogs.
4. **Merging.** Merge with `git merge --no-ff`. **Never squash**: squashing drops the `Entire-Checkpoint` trailers that attribution depends on.
5. **Commit prefixes.** Human fixes are separate commits prefixed `human:`. Operational work is prefixed `ops:` and excluded from every experiment.

## Entire checkpoint format

This section was verified on 2026-10-10 against 6 public repos (2,421 session rows). Redacted real samples are in `tests/fixtures/samples/`. Build against them.

### Two storage backends (read both)

| Backend | Where | Layout | Checkpoint id |
|---|---|---|---|
| `branch` (legacy, visible on GitHub) | `refs/heads/entire/checkpoints/v1`, one cumulative tree | `<id[0:2]>/<id[2:]>/…` | 12 hex chars, e.g. `02674b7ab946` → `02/674b7ab946/` |
| `git-refs` (default since CLI 0.10) | One ref per checkpoint: `refs/entire/checkpoints/<id[-2:]>/<id>` | The ref commit's tree root is the checkpoint | 26-char ULID (12-hex ids also occur) |

- An empty `entire/checkpoints/v1` branch means the repo migrated to refs, so always try both backends.
- On refs, the ref commit's message carries the trailers `Checkpoint: <id>`, `Entire-Session: <uuid>`, `Entire-Strategy: manual-commit|import` and `Entire-Agent: <name>`.
- Commits on code branches link to a checkpoint with the trailer `Entire-Checkpoint: <id>`.

### The tree of one checkpoint

```
metadata.json                 checkpoint root: cli_version, checkpoint_id, strategy, branch, files_touched, sessions[], token_usage
<n>/metadata.json             one per session in this checkpoint (n = 0, 1, …)
<n>/full.jsonl                the agent's native transcript (best-effort redacted)
<n>/transcript.jsonl          Entire's compact transcript (CLI ≥ 0.10)
<n>/prompt.txt                user prompts joined by "\n\n---\n\n" (sometimes missing)
<n>/content_hash.txt          "sha256:<hex>" of full.jsonl
tasks/<tool_use_id>/          subagents: task.json, agent-<id>.jsonl
```

- Paths in the root `sessions[]` are repo-absolute on the branch backend (`/02/674b7ab946/0/metadata.json`). Normalise them.

### Session `metadata.json`: the keys we use

| Key | Notes |
|---|---|
| `session_id` | The agent's own id. **The same session recurs across checkpoints.** Aggregate per session over all its checkpoints |
| `agent` | Display name: `Claude Code`, `Codex`, `Copilot CLI`, `Factory AI Droid`, `Pi`, … |
| `model` | Often `""`. Fall back to the transcript (below) |
| `created_at` | RFC3339; roughly the commit time |
| `token_usage.{input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, api_call_count}` | Covers **this checkpoint's slice** of the transcript, not the whole session. `input_tokens` excludes cached input |
| `files_touched[]` | Repo-relative paths |
| `initial_attribution.{agent_lines, agent_removed, human_added, human_modified, human_removed, total_committed, agent_percentage}` | Entire's own agent-vs-human line attribution for the commit |
| `prompt_attributions[]` | Per-prompt line attribution, when present |
| `session_metrics.turn_count`, `strategy`, `branch`, `cli_version` | `strategy: "import"` marks history imported from before capture. Exclude it from any event-period analysis |

- **Not recorded:** cost, a rules-file hash, the harness version (except inside transcripts), and the parent commit.

### Recovering the model and the rules file from transcripts

- **Claude Code `full.jsonl`:**
  - `type:"assistant"` lines carry `.message.model` and `.message.usage{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens}`.
  - `type:"attachment"` with `attachment.type:"model"` carries `identity.modelId`, e.g. `claude-opus-5-5[1m]`.
  - `attachment.type:"instructions"` (`files[].{path,type,content}`) and `"nested_memory"` carry the **full text of the CLAUDE.md files loaded**. That's the rules file. Hash the `type: Project` entries.
- **Codex `full.jsonl`:**
  - `turn_context.payload.model`
  - `world_state.payload.state.agents_md` (AGENTS.md)
  - `event_msg` with `payload.type:"token_count"` gives `info.total_token_usage{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}`
- **Copilot CLI and Factory Droid:** they record neither model nor tokens, so `cost = null` and the model is `unknown`.
- **Rules-file fallback:** hash `CLAUDE.md` / `AGENTS.md` at the parent of the session's first linked commit.

### Mapping recipe
1. List checkpoints from both backends.
2. Map each checkpoint to its commit through the `Entire-Checkpoint:` trailers on all branches.
3. For each `<n>/metadata.json`: `(session_id, checkpoint_id)` gives the token slice and the files.
4. Group by `session_id` to get one Session. Its tokens are the sum of its slices, and its commits are the set of linked commits.
5. Model: `metadata.model` if it isn't empty, otherwise the transcript.
6. The rules hash comes from the transcript attachments, otherwise from the parent-commit fallback.
7. The setup is `(agent, model, rules_hash)`.

## Features and acceptance

### Ingest
- **What it does:**
  - Full clone without checkout. (Until 13 Oct it was a partial clone, `--filter=blob:none`. On a cold machine that fetched every blob lazily during scoring, and `git log -p` and `git blame` timed out on every mature session.)
  - Fetch the `entire/checkpoints/v1` branch. If it's missing, fetch `refs/entire/checkpoints/*`. If neither exists, report "no Entire data" with a one-line how-to.
  - Parse each checkpoint into `Session` rows.
  - Map each checkpoint to its commit through the trailers on all branches.
  - Multi-session checkpoints become separate sessions. Subagent tasks attach to their parent. Sessions with no commit are kept with `commit_sha = null`. A commit with no trailer counts as human.
  - `n_user_prompts` excludes tool approvals.
- **Done when:**
  - it parses this repo plus 3 public repos
  - setup inference matches the prompt tags in ≥ 95% of sessions
  - a 300-session repo ingests in ≤ 60 s

### Score
Only *mature* sessions are scored: the commit is ≥ 5 first-parent commits **and** ≥ 6 h older than HEAD. Others are `too_young` with null metrics.

| Metric | Definition |
|---|---|
| `survival` | Lines the session's commit(s) added that `git blame -w -M -C HEAD` still attributes to them ÷ lines added. Whitespace-only and generated files (lockfiles, `dist/`, `*.min.*`) are ignored |
| `reverted` | A later commit says `This reverts commit <sha>`, **or** ≥ 50% of the added lines are deleted within the next 20 first-parent commits |
| `rework_human` / `rework_agent` | The share of added lines modified within 20 commits by commits without / with a checkpoint trailer |
| `unattended` | The session needed exactly one user prompt |
| `cost_usd` | Σ tokens by type × `src/price/prices.json`. Every row carries a source URL and date. An unknown model gives `null` |
| `cost_per_surviving_change` | Σ cost ÷ Σ survival, per setup |

### Difficulty and review
- **Difficulty** `d(s)`: the mean z-score of these, then split into terciles:
  - `log(1 + lines changed)`
  - files touched
  - graph impact size: `entire graph impact --symbol <s> --json` over the symbols in the touched hunks, or import fan-in when the graph is unavailable (the method used is recorded)
  - the length of the first prompt
- **Suspect:** the Mantel–Haenszel odds ratio for `bad = reverted ∨ rework_human > 0.3`, setup X vs the rest, stratified by tercile, with a 95% CI and p.
  - It needs ≥ 8 mature sessions for X. Otherwise the result is `insufficient data`.
  - The only labels are `suspect (level A, observational)`, `no suspect` and `insufficient data`.
- **Done when:** on a confounded fixture (X gets only the hard tasks), the raw rates would flag X and the matched comparison does not.

### Plan (coordinator)
- **The plan** (`plan.json`):
  - `suspect`
  - `tasks[]`: ≤ 12, stratified by tercile
  - `candidates[]`: ≤ 3 per iteration, ≤ 2 iterations
  - `budget_usd`
  - `stop_rules`
  - `rationale`: one paragraph
- **A task is eligible when:**
  - its session had ≤ 2 user prompts
  - the parent commit installs and its suite passes in the sandbox
  - hidden acceptance tests exist (otherwise it goes to the judge-only track, which is never used alone for promotion)

### Replay at the parent commit
- **Sandbox:**
  1. `git archive <parent> | tar -x` into a fresh directory.
  2. `git init`, then one base commit with a fixed author and date.
  3. Isolation proof: zero objects from `git rev-list --objects --all ^<parent>` exist in the sandbox, there are no remotes, a single ref, and no reflog beyond the base.
  - Clone + reset is forbidden (it's a denylist and leaks).
- **Rules swap:** write the setup's rules file into the sandbox and commit it as `setup:`, so the agent's diff excludes it.
- **Harness adapters** (`src/harness/*`, one contract):
  - **Claude Code:**
    ```
    claude -p "<task>" --model <m> --output-format json --max-turns 30
      --permission-mode acceptEdits --permission-prompts none --allowedTools "<allowlist>"
      --setting-sources project --strict-mcp-config --disable-slash-commands --max-budget-usd <cap>
    ```
    The child env is scrubbed of host-session variables. A setup file may carry provider env (`env`, with `${VAR}` filled from `.env`). DeepSeek candidates set `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`, `ANTHROPIC_AUTH_TOKEN` and the `ANTHROPIC_DEFAULT_*_MODEL` names. That endpoint ignores `cache_control`.
    JSON fields: `session_id, num_turns, duration_ms, total_cost_usd, usage, modelUsage, is_error, stop_reason`.
  - **Codex:**
    ```
    codex exec --json --model <m> --sandbox workspace-write -c approval_policy=never -C <ws> "<task>"
    ```
    Rules go in `AGENTS.md`. Tokens come from `turn.completed.usage`; it reports no USD (price it via `src/price`) and has no turn cap (use a wall-clock timeout).
- **Save:** `agent.patch` (`git diff --binary`) and the raw JSON or stream-json transcript.
- **Where replays run:** replays of public repos run only in isolated microVMs. Replays of this repo may run locally.

### Grade
1. **Grade in a separate copy:** base + `agent.patch` + hidden tests. Never grade in the agent's workspace.
2. **Hidden tests:** the test files the session added or modified in any of its commits, at the version the session itself left: its latest linked commit, or the merge that brought it into the main line. Maturity decides scoring only (survival and revert need age), not which test content counts. Later commits often edit a test file for features the original task never had, so reading the file at maturity judges the task against a contract it never saw.
3. **Run:** the agent's suite, then the full suite with per-test JUnit written outside the workspace. A hidden file that collects 0 tests counts as a failing case (bun's JUnit reporter silently drops files that fail to import).
4. **Scope guard:** pre-existing test cases are unmodified (appending new cases is allowed), no files outside the touched-directory set change, and typecheck and lint pass if configured.
5. **Blind diff-judge:** compares the two diffs under random labels. It's advisory.
6. **Disagreement:** if the grader and the judge disagree, or two setups split on a task, rerun it, up to k = 3, majority wins.
7. **Failure taxonomy:**

| Code | Failure |
|---|---|
| F1 | edited tests |
| F2 | never ran tests |
| F3 | suite regression |
| F4 | stopped early |
| F5 | loop, timeout or turn cap |
| F6 | environment or setup error. The task is excluded and resampled |
| F7 | off-scope edits |

**Verdict order:** `agent_error` > `no_changes` > `hidden_tests_failed` > `suite_failed` > guardrail flags > `pass`.

### Gate (deterministic code; the coordinator can't override it)

```
promote(candidate) iff, on the replay set (incumbent replayed as the control):
  hidden_pass(candidate) ≥ hidden_pass(incumbent)
  ∧ regressions == 0          # tasks the incumbent passed and the candidate failed, after reruns
  ∧ scope_violations == 0
  ∧ cost(candidate) ≤ budget
ties → cheaper wins; still tied → keep incumbent
```

- **Every rejection** writes `{candidate, failed_tasks, reasons, trace_url}`.
- **If no candidate passes,** the result is "no better setup found". That is a valid outcome.

### Candidate generation
- **Every candidate runs the Claude Code harness against DeepSeek's Anthropic-compatible endpoint.** Pre-registration amendment 2 fixes this.
  - `setups/candidates/E.json`: `deepseek-flash`
  - `setups/candidates/F.json`: `deepseek-v4-pro`
- **The candidates are:**
  - E and F with the default rules
  - rules mutations: X's harness and model with the rules file patched from X's top failure codes, using `src/candidates/rules-lib.md`. For example:
    - F2 → "run the full test suite before you finish"
    - F1 → "never modify existing tests unless asked"
- **Traceability:** every added rule cites the failure codes it answers.

### Act
- **On our own repo:** a PR with `setups/<id>.json`, the rules file, the review summary, an evidence table, neatlogs trace links and entire.io links.
- **On other people's repos:** never unsolicited. Only for teams that opted in.

### Observability (neatlogs)
- **Trace structure:** a `WORKFLOW review` root, then `AGENT coordinator`, then `TOOL` spans (one per ingest, score, replay attempt, grade and cfo.ai write), plus a `GUARDRAIL gate` span.
- **Attributes:** `roster.setup, roster.task, roster.attempt, roster.failure_code, roster.evidence_level, roster.repo, roster.cost_usd`.
- **Session:** `identify(session_id = review_id)`.
- **Detections:**

| Detection | Fires when |
|---|---|
| D1 silent pass | The visible suite passed, but hidden acceptance or the scope guard failed |
| D2 low attribution confidence | More than 30% of a setup's lines are unmapped |
| D3 cost anomaly | Cost exceeds 3× the incumbent median |
| D4 environment flake | F6 hits the same task across ≥ 2 setups |

- **No API key:** with `NEATLOGS_API_KEY` unset, observability is a no-op with one warning.

### Book (cfo.ai)
- **Writes over the cfo.ai MCP:**
  - an **AI Workforce** department: monthly spend per setup, surviving changes, cost per surviving change, unattended %
  - a **Hire 1 engineer vs scale the promoted setup** scenario
- **Verify:** read the blocks back and diff them against `book.json`. A mismatch means retry once, then report it.

### Forward run (pre-registered)
- **Registration:** the backlog (`experiments/forward-backlog.md`) and its acceptance tests (`experiments/acceptance/`) are committed, and their sha256 is published, **before** the review that picks the setups.
- **The acceptance tests** are written by a separate agent from the task text alone, before either setup runs.
- **Each task runs through both setups** in paired worktrees from the same main commit.
- **Grading is blind** (random X/Y labels).
- **Merge policy:** pass beats fail. If both pass, the blind judge's preference wins. If the judge ties, a random pick with a logged seed. Merge with `--no-ff`.
- **Statistics:** McNemar exact (two-sided, α = 0.05) on the pairs, and Wilcoxon signed-rank on cost.
- **Stop rule:** after ≥ 15 pairs, if the promoted setup has lost at least 3 more discordant pairs than it has won, open a revert PR and continue on the old setup.
- **Invalidated tasks** are excluded for both setups, with a reason.

## Models Roster itself uses

Roster's own reasoning runs on DeepSeek and never calls a Claude API. That covers the coordinator, the blind diff-judge and the acceptance-test writer.

- **API:** OpenAI-compatible chat completions with tool calling, at `https://api.deepseek.com`. The key comes from `DEEPSEEK_API_KEY`, set in `.env` and never in a prompt.
- **Models:** `deepseek-flash` by default (`ROSTER_LLM_MODEL`). The acceptance writer uses `deepseek-v4-pro` (`ROSTER_ACCEPTANCE_MODEL`).
- **Tracing:** every call is a neatlogs LLM span (OpenAI client wrapper).
- **Pricing:** DeepSeek bills peak and off-peak rates, with peak at 01:00–04:00 and 06:00–10:00 UTC on weekdays. Off-peak is half. Each call is priced for its own timestamp.

Replays are different. A replay reruns a coding-agent setup *as it is*, so replaying a Claude Code + Claude-model setup uses that setup's own model. That's the control.

## Architecture

- **Agent and CLI:** TypeScript on Bun (`bun:sqlite`, `bun test`).
- **Coordinator:** a tool-calling loop on DeepSeek's OpenAI-compatible API (`src/llm`). See §"Models Roster itself uses".
- **Web:** Next.js in `web/`, with its own `package.json`. The prebuild step copies `reports/` into `web/public/data`.
- **Sandboxes:** local temp dirs for this repo; microVMs for public repos.

### Layout

```
src/types.ts                         shared contracts
src/ingest/ src/identity/ src/price/
src/score/ src/difficulty/ src/review/
src/sandbox/ src/replay/ src/harness/{claude,codex}.ts src/grade/ src/gate/
src/agent/ src/candidates/ src/obs/ src/cfo/ src/act/ src/forward/
src/cli.ts + src/cli/<cmd>.ts
scripts/ (run-setup.sh, ledger.ts, sumcheck.ts, facts.ts, corpus-find.ts)
reports/ (generated JSON)   docs/FACTS.md (generated)   experiments/   setups/   web/   tests/
```

### CLI

```
roster review <repo> [--observational] [--budget <usd>] [--out reports/<slug>]
roster replay <repo> --tasks plan.json
roster gate <repo>
roster act <repo> [--pr]
roster book [--org <org>]
roster forward --backlog experiments/forward-backlog.md --pair OLD,NEW --parallel 4
roster acceptance --backlog experiments/forward-backlog.md --out experiments/acceptance/
roster facts
```

### Data model (`.roster/roster.db`, exported to `reports/*.json`)
- **`sessions`:**
  - `id, repo, checkpoint_id, harness, model, rules_hash, setup_id`
  - `tokens_in, tokens_out, cache_read, cache_write, cost_usd, n_user_prompts`
  - `first_prompt, commit_sha, started_at, ended_at, files[], entire_url, source`
- **`outcomes`:** `session_id, status (mature|too_young), survival, reverted, rework_human, rework_agent, unattended, tests_at_commit, difficulty, tercile`
- **`setups`:** `id, harness, model, rules_hash, rules_path, label`
- **`plans`:** `id, review_id, json, rationale, created_at`
- **`replays`:**
  - `id, plan_id, task_session_id, setup_id, attempt, isolation_proof, turns, duration_ms, cost_usd`
  - `hidden_pass, suite_pass, scope_ok, judge_equiv, failure_codes[], verdict, transcript_ref, trace_url`
- **`gate_decisions`:** `id, plan_id, candidate, verdict, reasons[], trace_url`
- **`forward_pairs`:** `task_id, setup_old, setup_new, pass_old, pass_new, cost_old, cost_new, merged, blind_labels, seed`
- **`events`:** an append-only step log. Every step is idempotent, and runs resume from here.

### Coordinator tools
- **Review and planning:** `ingest_repo, get_scorecard, get_difficulty, plan_replays`
- **Replays:** `run_replays, get_replay_results, rerun, classify_failures`
- **Decisions and action:** `propose_rules_candidate, gate, promote, revert, open_pr, book_cfo, verify_cfo_readback`
- **Context:** `query_traces` (neatlogs MCP), `graph_impact` (`entire graph`)

The system prompt includes: *"You decide what to try next. The gate decides what ships. Never claim a result the tools didn't return."* There's a hard stop at `budget_usd`.

### Recovery
Every recovery is a tested path, recorded as a TOOL span with `roster.attempt`.

| Failure | Recovery |
|---|---|
| Clone failure | Retry with a partial clone |
| Branch backend missing | Try the refs |
| Install failure at the parent | Retry with a frozen lockfile, then F6 and resample |
| Harness 429/5xx | Backoff, then the alternate inference profile |
| cfo.ai mismatch | Retry once, then report |
| Promotion regresses on replays | Gate rejection, then the next candidate |
| Promotion loses forward | The stop rule triggers a revert PR |
| Low attribution confidence | Abstain from naming a setup |

### Security
- Public repo code runs only in microVMs.
- No secrets in prompts: session transcripts are public.
- Sandboxes get only scoped, revocable keys.
- Entire shadow branches are never pushed.

## Claims
- **Where numbers come from:** `docs/FACTS.md`, which `roster facts` generates from `reports/`. `scripts/sumcheck.ts` must pass before any number is published.
- **Wording:** "significant" only when p < 0.05. Our own runs are labelled as ours. Tests are a proxy for value, and the README says so.
