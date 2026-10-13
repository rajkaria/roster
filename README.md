# Roster

> Roster is an agent that runs performance reviews for your AI coding agents, and tests whether its call holds.

## The result

Four AI coding setups built this repo. Roster reviewed them and replaced Claude Code + Sonnet 5.5 (**B**) with Claude Code on DeepSeek Flash (**E**). Before it made that call, we froze 40 new build tasks and their acceptance tests (hash published). Then each task was built twice, once by B and once by E, and graded against those frozen tests (a blind diff judge only breaks merge ties).

| Forward test, pre-registered (final: 35 valid pairs) | |
|---|---|
| Tasks only E passed | **11** |
| Tasks only B passed | **1** |
| Both passed / both failed | 20 / 3 |
| McNemar exact, two-sided | **p = 0.006** |
| Cost per task | E cheaper in 35 of 35 pairs: median $0.020 vs $0.148 (Wilcoxon p < 0.001) |

What changed these numbers, each disclosed in a dated [amendment](experiments/PREREGISTRATION.md#amendments) before the affected result was seen:
- **35 valid pairs** of 40 tasks. F11 is excluded for a network outage (amendment 11). F04, F05, F06 and F08 are excluded because both sides failed only on a test inherited from their base commit (amendment 18). Counting those four as recorded (both fail) gives the same 11 vs 1 and p = 0.006.
- **11 vs 1** is after the grading fixes and logged regrades of amendments 12–16. The overloaded build machine had timed out or killed full-suite runs, which were then recorded as failures. The regrades re-ran grading on each agent's recorded branch; no agent was re-run.
- **Costs** are re-priced from each run's tokens, because Claude Code priced DeepSeek tokens at Claude rates (amendment 10).
- **Build-only merges** put F04, F05, F06, F08 and F09 on `main` so later tasks could build on them (amendments 17 and 18). They change no recorded result.

Every number here comes from [`docs/FACTS.md`](docs/FACTS.md) or [`reports/self/forward.json`](reports/self/forward.json), both generated from the run. The pairs are on the [experiment page](https://tryroster.dev/experiment).

**How the call was made: v1, then v2.**
- **v1:** Roster's first review promoted E on a 0–0 tie. B and E both failed all 10 replayed tasks that have hidden tests, so the cheaper one won, with no quality signal. We disclosed that before the forward run (amendment 7).
- **v2:** we fixed the replay (hidden tests now come with their support files) and taught the gate to refuse a tie with no signal.
- **Review 1b:** the same 10 tasks under v2. B passes 1, E passes 0, and the gate **rejects** E.
- **What that means:** replaying past tasks is a weak signal. The pre-registered forward test is the strong one, and it says the call held.

## What it does

It reads every session your coding agents recorded with [Entire](https://entire.io), and for each one works out:
- what it cost
- whether its change survived
- whether it was reverted, or reworked by a person

Then it tests a better setup on your own past tasks, and promotes that setup only if nothing regresses.

**Live:**
- [tryroster.dev](https://tryroster.dev) (also at [roster-five-chi.vercel.app](https://roster-five-chi.vercel.app))
- [our own AI team's review](https://tryroster.dev/r/rajkaria/roster)
- [all reviews](https://tryroster.dev/r)
- [the AI-workforce book](https://tryroster.dev/book)

## How it works

A **setup** is a coding-agent harness, a model and a rules file, for example Claude Code with Sonnet 5.5 and your `CLAUDE.md`. Roster:

1. **Reviews:** it scores every recorded session of every setup.
   - It prices the session from its tokens.
   - It checks whether its lines survived at `HEAD`, were reverted, or were reworked by a person.
   - It checks whether the session ran unattended.
   - Setups are compared on tasks of similar difficulty (Mantel–Haenszel across difficulty terciles). This is **evidence level A, observational**: it can name a suspect but proves nothing on its own.
2. **Replays:** it reruns a setup's real past tasks at their parent commit, in a sandbox with no future history.
   - Each task runs under the incumbent setup and under candidate setups.
   - Each attempt is graded with the tests the team kept, the full suite, a scope guard and a blind diff judge.
   - **Level B.**
3. **Gates:** a deterministic gate promotes a candidate only if nothing regresses. The model decides what to try next, and the gate decides what ships.
4. **Tests forward:** new tasks, written and hashed before the decision, run through the old and the new setup side by side and are graded against acceptance tests frozen before the decision (a blind diff judge only breaks merge ties). **Level C.**
5. **Books:** it writes the AI team's spend per setup into the company's [cfo.ai](https://cfo.ai) plan, with a hire-or-scale scenario, and reads it back to verify. This repo's book is written and verified.

With `NEATLOGS_API_KEY` set, each Roster run sends a trace to [neatlogs](https://neatlogs.com).

## This repo is the experiment

Four coding-agent setups built this repo, assigned to tasks by a seeded shuffle and recorded by Entire ([`setups/`](setups)):

| Setup | Harness | Model | Rules |
|---|---|---|---|
| A | Claude Code | Opus 5.5 | default |
| B | Claude Code | Sonnet 5.5 | default |
| C | Claude Code | Haiku 5.5 | default |
| D | Claude Code | Sonnet 5.5 | default + strict |

The candidates run Claude Code on DeepSeek:

| Candidate | Model |
|---|---|
| E | DeepSeek Flash |
| F | DeepSeek V4 Pro |

The test was fixed in advance in [`experiments/PREREGISTRATION.md`](experiments/PREREGISTRATION.md):
- The 40 forward tasks and their acceptance tests were frozen before the first review. The hashes are in [`experiments/FREEZE.txt`](experiments/FREEZE.txt).
- Every change since then is a dated amendment, including two protocol deviations and the first review's weak evidence.

**Status:** the forward run is complete: 40 tasks, 39 recorded pairs, 35 valid (exclusions under amendments 11 and 18, above). The exploratory secondary outcome (blind judge preference, not H1; amendments 8 and 10) preferred E in 14 pairs and B in 11, with 1 tie and 9 with no eligible side ([`reports/self/forward.json`](reports/self/forward.json)).

**This repo's own review** (level A, [live](https://tryroster.dev/r/rajkaria/roster)), after the forward run: 154 sessions across 5 setups, at least $44.03 of spend (some Haiku sessions are priced as a lower bound). DeepSeek Flash cost $1.26 over 40 sessions, the least per surviving change. Level A finds no suspect (odds ratio 8.10, p = 1.000), so this review alone calls no setup worse.

## Roster caught its own silent mistakes

Reviewing its own build, Roster's v1 output was green but wrong six times. Each was fixed by a recorded agent task, and each fix commit names its Entire checkpoint:
- It saw 3 setups where there were 4 ([T29](https://github.com/rajkaria/roster/commit/6ce9f9b), [T41](https://github.com/rajkaria/roster/commit/f7bb19e)).
- It priced Haiku sessions at $0 ([T30](https://github.com/rajkaria/roster/commit/9173313), [T40](https://github.com/rajkaria/roster/commit/02c795d)).
- It read hidden tests only from a session's last commit, so 16 of the 23 sessions it had then reviewed had none ([T36](https://github.com/rajkaria/roster/commit/a33938b), [T44](https://github.com/rajkaria/roster/commit/b501a48)).
- It counted one prompt as three ([T37](https://github.com/rajkaria/roster/commit/1c758d7)).
- Its replays failed without a reason ([T38](https://github.com/rajkaria/roster/commit/7fcfbce)).
- It priced DeepSeek runs at Claude rates ([T43](https://github.com/rajkaria/roster/commit/c0193e2)).

The build log in [`hackathon.md`](hackathon.md) has the details.

## Run it

```bash
bun install
bun src/cli.ts review https://github.com/<owner>/<repo> --observational   # level A, read-only, no model calls
bun src/cli.ts run <repo> --budget 5                                        # coordinator: plan, replay, gate (DeepSeek)
bun src/cli.ts forward --backlog <file> --pair OLD,NEW                      # paired forward run, graded against frozen acceptance tests
bun src/cli.ts traces flush                                                 # re-send neatlogs traces a run could not deliver
bun scripts/book-self.ts --write                                            # this repo's book, written into cfo.ai and read back
```

**Requirements:**
- The repo must record sessions with Entire (`entire/checkpoints/v1` or `refs/entire/checkpoints/*`).
- Replays need the Claude Code CLI.
- Roster's own reasoning uses DeepSeek: set `DEEPSEEK_API_KEY` in `.env`.
- Tracing needs `NEATLOGS_API_KEY`. Writing the book needs a cfo.ai connection.

[`docs/DESIGN.md`](docs/DESIGN.md) is the engineering contract.

## After the deadline (from 13 Oct)

Added during judging, with the organisers' go-ahead. Every commit is prefixed `post-deadline:`. Nothing above changed: `reports/`, `docs/FACTS.md` and the forward run are as submitted.

- **Live reviews:** paste any public repo that records its agents' sessions with Entire into [tryroster.dev/try](https://tryroster.dev/try).
  - Roster runs a level-A review on a GitHub Actions runner and publishes it on [tryroster.dev/r](https://tryroster.dev/r), usually within a few minutes.
  - Every run and result is committed to [rajkaria/roster-reviews](https://github.com/rajkaria/roster-reviews), which also re-reviews known Entire repos daily.
- **In your own CI:** add this to a workflow.
  ```yaml
  - uses: rajkaria/roster@main
  ```
  It writes the review to the job summary. [`action.yml`](action.yml) has the private-repo variant.
- **Fixes found by running it on other repos:**
  - Cold reviews now make a full clone. A partial clone timed out scoring every mature session.
  - A session git fails on is `not_scored`, never `too_young`.
  - A session's tokens are counted once. Entire stores a multi-checkpoint session's usage as a running total, and Claude Code repeats usage on every content-block row.

## Built with

**[Entire](https://entire.io)** is the data Roster reads (sessions, prompts, tokens, model, commit), and it recorded every agent session that built Roster.
- Sessions: [entire.io/gh/rajkaria/roster](https://entire.io/gh/rajkaria/roster) (opens logged out). For example, [the T63 session](https://entire.io/gh/rajkaria/roster/session/8dd7b762-fcec-4319-b8df-862a07469dad) is the recorded Claude Code + Haiku 5.5 session that taught the gate to refuse a tie with no signal: three commits, 183.8K tokens.
- Checkpoints: the [`entire/checkpoints/v1`](https://github.com/rajkaria/roster/tree/entire/checkpoints/v1) branch. Agent commits name their checkpoint in an `Entire-Checkpoint` trailer, for example [T36's fix](https://github.com/rajkaria/roster/commit/a33938b) and checkpoint `ff38daae0ff6`.

**[neatlogs](https://neatlogs.com)** traces Roster's runs, from ingest to each replay attempt and gate decision.
- **Before** (review 1, v1 gate): trace `820af0a5dd1c888b70af931671d9cbb8`. Hidden tests passed: B 0 of 10, E 0 of 10. The v1 gate promoted E.
- **After** (review 1b, v2 gate): trace `38f71c40ceb5fca5b7046542fa9e17f2`. Hidden tests passed: B 1 of 10, E 0 of 10. The v2 gate rejected E.
- Both traces are re-emitted from recorded results; span timings are emission times ([`reports/self/neatlogs-before-after.json`](reports/self/neatlogs-before-after.json)).
- The neatlogs SDK's exporter times out under Bun, so Roster re-sends lost traces itself as OTLP protobuf ([a8e8117](https://github.com/rajkaria/roster/commit/a8e8117)).

**[cfo.ai](https://cfo.ai)** holds the company plan, and Roster books the AI team into it as a department.
- **The book:** Roster wrote this repo's AI-workforce book into cfo.ai through its own bridge and verified the read-back. [Read-only link](https://app.cfo.ai/s/lITFLQ-6eGU21WPi) (opens logged out).
- **The plan:** pricing, unit economics, revenue, opex and headcount, cash and runway, under Base, Downside and Upside scenarios. Runway is 17 months in Base, 15 in Downside, and beyond 24 in Upside, which turns cash-flow positive from month 12. Starting cash of $150k is an assumption, like pricing and growth; every input is labelled MEASURED or ASSUMPTION. [Read-only link](https://app.cfo.ai/s/dt32CtLs-jXlUkoT) (opens logged out).

## Limits

- **Live now:** the site, including this repo's review, the experiment, the review index, `/try` and `/book`; the CLI's `review`, `run`, `forward` and `traces`.
- **Built, not live:** `/try` only links reviews that already exist; it doesn't start one. `roster run --pr` records the pull-request command; it opens the pull request only with `--open`, for a repo listed in `opt-ins.json`.
- **Not built:** isolated VMs for replays. Replays of public repos must run in isolated VMs; local replays are only for repos you trust.
- Tests are a proxy for value.
- Level A on a young repo is mostly "insufficient data" or "no suspect", by design.
- The forward test covers one repo and one pair of setups, on one build machine whose overload forced the grading fixes in amendments 12–16.

## License

MIT
