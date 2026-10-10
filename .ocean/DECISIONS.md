# Decision Journal

Every autonomous decision gets an entry. Two-way doors get one line; one-way
doors get the full block.

<!-- Template for one-way doors:
## D<N>: <title>
- **Sprint:** <n>  **Date:** <YYYY-MM-DD>
- **Options:** <a> / <b> / <c>
- **Chose:** <x>
- **Why:** <reasoning — user workflow first, implementation convenience last>
- **Cost to reverse:** <low/medium/high — what it would take>
-->

## 2026-10-10 18:15 IST · Product code is written only by the four recorded setups (one-way door)
- **Options:**
  - (a) the orchestrator's own subagents build everything, which is fast
  - (b) every product task runs through `scripts/run-setup.sh` under its pre-registered setup, as a separate Claude Code or Codex process captured by Entire
- **Choice:** (b).
- **Why:** this repo is the dataset Roster reviews, and the pre-registration fixes the setup assignment. Code written outside a recorded setup session would show up as human work and break the experiment.
- **Cost to reverse:** high. Anything built outside the protocol would have to be labelled as excluded.

## 2026-10-10 18:15 IST · Builds run with project-only settings
- **Decision:** `--setting-sources project --strict-mcp-config`, with a project permission allowlist in `.claude/settings.json`.
- **Why:** the kickoff spike showed that host plugins and hooks leak into every setup otherwise.
- **Reversible:** yes.

## 2026-10-10 18:15 IST · The Entire branch backend
- **Decision:** `entire/checkpoints/v1`, not hidden refs.
- **Why:** it's visible on GitHub, and `entire judge add` fetches `refs/heads/entire/*`.
- **Reader:** Roster still reads both backends.

## 2026-10-10 19:40 IST · DeepSeek for the product, Claude only for replaying the setups under review (one-way door, operator decision)
- **What the operator decided:** "don't use claude apis for the product", plus their answer to the question "DeepSeek candidates only".
- **The rule now:**
  - Roster's own LLM calls (coordinator, judge, acceptance writer) go to DeepSeek's OpenAI-compatible API, traced with neatlogs `wrapOpenAI`.
  - Originals are replayed as they are, as the control.
  - Candidates run Claude Code against `https://api.deepseek.com/anthropic` (E = deepseek-flash, F = deepseek-v4-pro).
- **What it costs:** that endpoint ignores `cache_control`, and its pricing depends on time of day.
- **To reverse it:** add Claude candidates back to `setups/candidates/`. The pre-registration amendment stays on the record.
