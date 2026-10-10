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
