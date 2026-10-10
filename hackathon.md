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
