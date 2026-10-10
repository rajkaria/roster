# Roster: neatHack build log

## Project
- **Name:** Roster
- **One line:** an agent that runs performance reviews for your AI coding agents.
- **Problem:** teams run several coding-agent setups (harness, model, rules file). They can't see which setup's work survives and which gets reverted or rewritten, so they pick setups on feel. They also can't plan "hire an engineer, or scale the agents?" with real numbers.

## Team
- Raj Karia ([@rajkaria](https://github.com/rajkaria))

## Stack
- **Used now:** TypeScript on Bun, Claude Code.
- **Planned, not yet in use:**
  - Codex CLI, still pending installation
  - Entire for session capture, then checkpoints as Roster's input
  - neatlogs for tracing Roster's runs
  - cfo.ai for the AI-workforce line and the business plan
  - Next.js on Vercel
  - Amazon Bedrock

## Build log
- **2026-10-10 12:30 IST:** the build window opened.
- **2026-10-10 15:10–15:20 IST:** a spike on replaying a past agent task at its parent commit.
  - **Sandbox:** `git archive` held 0 of 6 future objects.
  - **Rules swap:** a permissive rules file led the agent to edit an existing test. A strict one didn't, and the grader flagged the difference.
  - **Headless CLI:** couldn't authenticate yet, so no cost was measured.
- **2026-10-10 ~18:10 IST:** repo created; skeleton, setup definitions, design contract and pre-registration committed.
- **2026-10-10 18:48 IST:** Entire enabled (branch backend, email and phone redaction on).
  - A one-line canary session (T00) confirmed that each checkpoint records the agent, the model, the token usage, the files and the setup tag.
- **2026-10-10 18:50–19:00 IST:** two privacy fixes before any session data went public.
  - **Isolated config:** setup sessions now run with their own Claude Code config directory.
  - **Worktrees moved out of `$HOME`:** Claude Code loads `<ancestor>/.claude/CLAUDE.md` for every ancestor directory, so the operator's personal rules file had been entering session transcripts.
  - Both canary checkpoints that contained it were deleted before being pushed.
- **2026-10-10 19:00 IST:** setup C switched to Claude Code + Haiku 5.5. Codex wasn't available, so the pre-registered fallback applied (`experiments/PREREGISTRATION.md`, amendment 1).
- **2026-10-10 19:00–19:10 IST:** wave 1 ran as 5 parallel recorded sessions:
  - T01 shared types and fixture builder (A)
  - T05 price table (C)
  - T09 replay sandbox (D)
  - T13 web skeleton (B)
  - T15 sumcheck and facts (B)
  - All merged with `--no-ff`. The suite passes and the typecheck is clean.

- **2026-10-10 19:10 → 2026-10-11 01:30 IST:** waves 2–4 and B2, plus integration tasks T27–T51.
  - Everything is merged with `--no-ff`, about 50 recorded agent sessions in all. The suite has 478 tests and passes.
  - The web app is live at https://roster-five-chi.vercel.app with this repo's own review.
- **Roster's review of its own repo caught its own silent mistakes.** Each was a green run with a wrong number, and each was fixed by a recorded task:
  - it saw 3 setups where there are 4 (T29, T41)
  - Haiku sessions were priced at $0 (T30, T40)
  - 16 of 23 tasks lost their hidden tests (T36, T44)
  - prompts were counted once per checkpoint (T37, T41)
  - replays failed silently when the rules file was unchanged (T38)
  - DeepSeek runs were priced with Claude prices (T43)
- **Protocol deviation:** sessions T18 and T28 ran without setup D's rules. Pre-registration amendment 4 records it and how they're analysed.
- **2026-10-10 22:40 IST:** the forward backlog (40 tasks) and its 40 acceptance tests were frozen before any review. The hashes are in `experiments/FREEZE.txt`.
- **First end-to-end replay (G4):** a past task (T12) was replayed at its parent commit under setup C and DeepSeek candidate E.
  - C passed the suite but failed the original task's hidden tests.
  - E ran out of turns at the 40-turn cap. The original session took 59, so the cap now scales with the original (T46).
  - E's cost is now priced from tokens: $0.045, against Claude Code's $2.01 estimate.

## Demo
- Pending.

## Known limitations and next steps
- Nothing is live yet.
- Every number will come from `docs/FACTS.md`, which is generated from `reports/`.

## Submission
- **Confirmed requirements:**
  - a public repo with commits made during the event
  - a demo video of 3 minutes or less covering neatlogs, Entire and cfo.ai
  - a cfo.ai plan with pricing, costs, revenue and runway
  - neatlogs before/after runs with the numbers compared
  - a failed-action recovery run
  - #neatHack posts
- **Outstanding:** all of the above.
