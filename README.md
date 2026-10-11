# Roster

> Roster is an agent that runs performance reviews for your AI coding agents.

It reads every session your coding agents recorded with [Entire](https://entire.io), and for each one works out:
- what it cost
- whether its change survived
- whether it was reverted, or reworked by a person

Then it tests a better setup on your own past tasks, and ships that setup only if nothing regresses.

**Live:**
- [roster-five-chi.vercel.app](https://roster-five-chi.vercel.app)
- [our own AI team's review](https://roster-five-chi.vercel.app/r/rajkaria/roster)
- [all reviews](https://roster-five-chi.vercel.app/r)

## What it does

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
4. **Tests forward:** new tasks, written and hashed before the decision, run through the old and the new setup side by side and are graded blind. **Level C.**
5. **Books:** it writes the AI team's spend per setup into the company's [cfo.ai](https://cfo.ai) plan, with a hire-or-scale scenario. *(Pending: needs the cfo.ai connection.)*

Every Roster run is traced in [neatlogs](https://neatlogs.com).

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

**Status, from [`docs/FACTS.md`](docs/FACTS.md):**
- **Level A:** Roster reviewed its own repo (61 sessions, 4 setups) and found **no suspect** (odds ratio 4.23, p = 1.000).
- **Level B:** Review 1 promoted **E** over B. The two tied at zero hidden-test passes, and E was cheaper. That is weak evidence, and amendment 7 says so: even the incumbent failed its own replayed tasks. The replay bug behind it is being fixed.
- **Level C:** the forward run of B against E is in progress. Results will be published whatever they show.

## Roster caught its own silent mistakes

Reviewing its own build, Roster's v1 output was green but wrong six times. Each was fixed by a recorded agent task:
- It saw 3 setups where there were 4.
- It priced Haiku sessions at $0.
- It dropped the hidden tests of 16 of 23 tasks.
- It counted one prompt as three.
- Its replays failed without a reason.
- It priced DeepSeek runs at Claude rates.

The build log in [`hackathon.md`](hackathon.md) has the details.

## Run it

```bash
bun install
bun src/cli.ts review https://github.com/<owner>/<repo> --observational   # level A, read-only, no model calls
bun src/cli.ts run <repo> --budget 5                                        # coordinator: plan, replay, gate (DeepSeek)
bun src/cli.ts forward --backlog <file> --pair OLD,NEW                      # paired forward run, blind grading
```

**Requirements:**
- The repo must record sessions with Entire (`entire/checkpoints/v1` or `refs/entire/checkpoints/*`).
- Replays need the Claude Code CLI.
- Roster's own reasoning uses DeepSeek: set `DEEPSEEK_API_KEY` in `.env`.

[`docs/DESIGN.md`](docs/DESIGN.md) is the engineering contract.

## Built with

| Tool | What it does in Roster |
|---|---|
| **Entire** | The data Roster reads (sessions, prompts, tokens, model, commit), and the recorder for every session that built Roster |
| **neatlogs** | Traces every Roster run, from ingest to each replay attempt and gate decision |
| **cfo.ai** | Where Roster books the AI team as a department of the company plan *(connection pending)* |

## Limits

- Tests are a proxy for value.
- Level A on a young repo is mostly "insufficient data" or "no suspect", by design.
- Replays of public repos must run in isolated VMs; local replays are only for repos you trust.

## License

MIT
