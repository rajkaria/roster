# Roster: neatHack build log

## Project
- **Name:** Roster
- **One line:** an agent that runs performance reviews for your AI coding agents.
- **Problem:** teams run several coding-agent setups: a coding agent, a model and a rules file. They can't see which setup's work survives and which gets reverted or rewritten, so they pick setups on feel. They also can't plan "hire an engineer, or scale the agents?" with real numbers.

## Team
- Raj Karia ([@rajkaria](https://github.com/rajkaria))

## Stack
- TypeScript on Bun; the web app is Next.js on Vercel.
- Claude Code built Roster, under four recorded setups (A–D, [`setups/`](setups)). The forward run added Claude Code on DeepSeek Flash (E).
- Roster's own reasoning (the coordinator) runs on DeepSeek.
- **Entire** records every agent session; **neatlogs** traces Roster's runs; **cfo.ai** holds the AI-workforce book and the business plan. What each one does is under "The three tools" below.
- Codex CLI wasn't available, so setup C fell back to Claude Code + Haiku 5.5 (amendment 1).

## Timeline (IST)

### Saturday 10 October
- **12:30:** the build window opened.
- **15:10–15:20:** a spike on replaying a past agent task at its parent commit.
  - **Sandbox:** `git archive` held 0 of 6 future objects.
  - **Rules swap:** a permissive rules file led the agent to edit an existing test. A strict one didn't, and the grader flagged the difference.
  - **Headless CLI:** it couldn't authenticate yet, so no cost was measured.
- **~18:10:** repo created; skeleton, setup definitions, design contract and pre-registration committed.
- **18:48:** Entire enabled (branch backend, email and phone redaction on).
  - A one-line canary session (T00) confirmed that each checkpoint records the agent, the model, the token usage, the files and the setup tag.
- **18:50–19:00:** two privacy fixes before any session data went public.
  - **Isolated config:** setup sessions run with their own Claude Code config directory.
  - **Worktrees moved out of `$HOME`:** Claude Code loads `<ancestor>/.claude/CLAUDE.md` for every ancestor directory, so the operator's personal rules file had been entering session transcripts.
  - Both canary checkpoints that contained it were deleted before being pushed.
- **19:00:** setup C switched to Claude Code + Haiku 5.5 under the pre-registered fallback (amendment 1).
- **19:00–19:10:** wave 1 ran as 5 parallel recorded sessions: T01 shared types and fixture builder (A), T05 price table (C), T09 replay sandbox (D), T13 web skeleton (B), T15 sumcheck and facts (B). All merged with `--no-ff`.
- **19:10 → Sunday 01:30:** waves 2–4 and integration tasks T27–T51, every one a recorded agent session merged with `--no-ff`. The web app went live at https://roster-five-chi.vercel.app with this repo's own review.
- **22:48:** the forward backlog (40 tasks) and its 40 acceptance tests were frozen before any review (amendment 5). The hashes are in [`experiments/FREEZE.txt`](experiments/FREEZE.txt).

### Sunday 11 October
- **First end-to-end replay:** a past task (T12) was replayed at its parent commit under setup C and DeepSeek candidate E.
  - C passed the suite but failed the original task's hidden tests.
  - E ran out of turns at the fixed turn cap, which was lower than the original session needed. The cap now scales with the original session (T46).
  - E's cost is priced from its tokens, because Claude Code's own estimate uses Claude rates (T43).
- **10:39, review 1:** Roster's first performance review of this repo.
  - Level A found no suspect.
  - The coordinator replayed setup B's past tasks under B and the DeepSeek candidates E and F. The gate promoted E on a 0–0 hidden-test tie: cheaper wins. That is no quality signal, and amendment 7 disclosed it at 10:40, before the forward run.
- **10:41:** the forward run started: the 40 frozen tasks, each built by B and by E in paired worktrees from the same `main` commit, and graded against the frozen acceptance tests.
- **10:54:** T63 merged the v2 fixes: hidden tests now come with their support files, and the gate refuses a tie with no signal.
- **11:40 → Monday 03:15:** problems found during the forward run, each fixed by an `ops:` commit and dated in the pre-registration before the affected results were seen:
  - The frozen acceptance tests were over-specified (amendment 8). H1 stayed as registered.
  - A headless session could wait forever for a background command, so one guardrail line was added for all sessions (amendment 9).
  - Claude Code priced DeepSeek runs at Claude rates, so every pair was re-priced from its tokens (amendment 10, T67).
  - F11 hit a network outage on both sides and was excluded, not rerun (amendment 11).
  - The grader timed out every full-suite run, and later the overloaded machine killed suites. Grading got longer limits, failure logging, a shared machine-wide grading slot and fair turns, and every affected pair got one final logged regrade on its recorded branches (amendments 12–16).
  - F06 failed on a test inherited from its base commit, on both sides. It was merged as build progress only, so the tasks that depend on it could start (amendment 17).
  - The same inherited test was the only failure on both sides of F04, F05, F06 and F08. They were excluded as environment failures, with a sensitivity analysis reported alongside, and F04, F05, F08 and F09 were merged as build progress (amendment 18).

### Monday 12 October
- **03:59, review 1b:** review 1's 10 hidden-test tasks re-run under the v2 replay and gate. B passes 1, E passes 0, and the gate rejects E. Detection D1 (visible suite passed, hidden tests failed) fired 16 times, 8 on each side.
- **04:54:** final forward result (below).
- **04:56:** this repo's review regenerated after the forward run, and the AI-workforce book built from it.
- **07:27:** DeepSeek sessions in the review priced by their start time (T83); the book finds the promoted setup in the review (T84).
- **08:10–08:13:** neatlogs delivery fixed and the before/after traces sent (below).
- **08:24–08:38:** the AI-workforce book written into cfo.ai and verified; the business plan built in cfo.ai; read-only share links created.

## The three tools

**Entire** is Roster's input. Roster reads its checkpoints (sessions, prompts, tokens, model, commit) to review a repo. Entire also recorded every agent session that built Roster: the [`entire/checkpoints/v1`](https://github.com/rajkaria/roster/tree/entire/checkpoints/v1) branch holds them, and agent commits name their checkpoint in an `Entire-Checkpoint` trailer.

**neatlogs** traces Roster's runs: ingest, each replay attempt, each gate decision, and the detections.
- The neatlogs SDK's exporter times out under Bun, so traces never arrived. Roster spools what the SDK loses and re-sends it itself as OTLP protobuf, because neatlogs ingest rejects OTLP/JSON ([6c425ce](https://github.com/rajkaria/roster/commit/6c425ce), [a8e8117](https://github.com/rajkaria/roster/commit/a8e8117)). `roster traces list|flush` re-sends anything still undelivered.
- **Before/after**, on the same 10 tasks and setups B and E ([`reports/self/neatlogs-before-after.json`](reports/self/neatlogs-before-after.json)):
  - Before (review 1, v1 gate): trace `820af0a5dd1c888b70af931671d9cbb8`. Hidden tests passed B 0 of 10, E 0 of 10; the v1 gate promoted E.
  - After (review 1b, v2 gate): trace `38f71c40ceb5fca5b7046542fa9e17f2`. Hidden tests passed B 1 of 10, E 0 of 10; the v2 gate rejected E.
  - Both traces were re-emitted from the recorded results, so span timings are emission times.

**cfo.ai** holds the company plan, and Roster books the AI team into it.
- `bun scripts/book-self.ts --write` writes this repo's AI-workforce book into cfo.ai through Roster's own bridge (Claude Code with the cfo.ai MCP server) and reads it back to verify. It's written and verified ([`reports/self/book.json`](reports/self/book.json)). [Read-only book](https://app.cfo.ai/s/lITFLQ-6eGU21WPi).
- The business plan is built in cfo.ai: pricing, unit economics, revenue, opex and headcount, cash and runway, under Base, Downside and Upside scenarios. Runway is 17 months in Base, 15 in Downside, and beyond 24 in Upside, which turns cash-flow positive from month 12. Starting cash of $150k is an assumption, as are pricing and growth ([`reports/self/cfo-plan.json`](reports/self/cfo-plan.json)). [Read-only plan](https://app.cfo.ai/s/dt32CtLs-jXlUkoT).

## What Roster found in its own build

Roster's review of its own repo caught its own silent mistakes. Each was a green run with a wrong number, and each was fixed by a recorded agent task:
- it saw 3 setups where there are 4 (T29, T41)
- Haiku sessions were priced at $0 (T30, T40)
- it read hidden tests only from a session's last commit, so 16 of the 23 sessions it had then reviewed had none (T36, T44)
- prompts were counted once per checkpoint, so one prompt became three (T37, T41)
- replays failed silently when the rules file was unchanged (T38)
- DeepSeek runs were priced with Claude prices (T43; the forward run in T67; the review in T83)

Then its first real decision was weak. Review 1 promoted E on a 0–0 tie, because the replay didn't copy the hidden tests' support files (the likely cause named in amendment 7), so both B and E failed every hidden-test task. T63 fixed both the replay and the gate (v2). Review 1b re-ran the same tasks under v2: the gate rejected E.

**Protocol deviations**, both disclosed: sessions T18 and T28 ran without setup D's rules (amendment 4), and T66 ran under D instead of B (amendment 10).

## The forward result

From [`reports/self/forward.json`](reports/self/forward.json) and [`docs/FACTS.md`](docs/FACTS.md):
- 40 tasks, 39 recorded pairs, **35 valid** after the exclusions in amendments 11 and 18.
- **E passed where B failed 11 times; B passed where E failed once.** McNemar exact, two-sided: **p = 0.006**. Both passed 20, both failed 3.
- Counting the four amendment-18 pairs as recorded gives the same 11 vs 1 and p = 0.006.
- **E was cheaper in 35 of 35 pairs:** median $0.020 vs $0.148 (Wilcoxon p < 0.001).
- Exploratory secondary outcome (blind judge preference, not H1): E 14, B 11, 1 tie, 9 with no eligible side.

So review 1's call held on new work, even though the evidence review 1 used for it was weak. Replaying past tasks is the weak signal; the pre-registered forward test is the strong one.

This repo's own review after the forward run: 154 sessions across 5 setups, at least $44.03 of spend. DeepSeek Flash cost $1.26 over 40 sessions, the least per surviving change. Level A finds no suspect (odds ratio 8.10, p = 1.000).

## Demo
- Live: https://tryroster.dev, also at https://roster-five-chi.vercel.app (the result on the home page; `/experiment`, `/r`, `/r/rajkaria/roster`, `/try`, `/book`).
- CLI: `bun src/cli.ts review <github-url> --observational`.

## Limitations
- **Live now:**
  - the site: this repo's review, the experiment, the review index, `/try` and `/book`
  - the CLI: `review`, `run` (plan, replay, gate), `forward` and `traces`
  - the cfo.ai book and plan, with read-only links
- **Built, not live:**
  - `/try` only links reviews that already exist; it doesn't start one.
  - `roster run --pr` records the pull-request command and opens it only with `--open`, for a repo listed in `opt-ins.json`.
- **Not built:**
  - isolated VMs for replays: local replays are only for repos you trust.
- **What the evidence covers:**
  - The forward test covers one repo and one pair of setups, on one build machine whose overload forced the grading fixes in amendments 12–16.
  - Tests are a proxy for value.
  - Level A on a young repo is mostly "insufficient data" or "no suspect", by design.
- **Assumptions:** the cfo.ai plan's starting cash, pricing and growth.
- **Re-emitted traces:** the neatlogs before/after traces were re-emitted from recorded results.
