# Pre-registration: Roster's self-build experiment

**Registered:** 2026-10-10, during neatHack. The registration is the commit that first adds this file. Later changes go only in **Amendments** at the bottom, dated, and nothing above that heading is edited.

## The question
Four coding-agent setups (`setups/A.json`–`D.json`) build this repository. Partway through the build, Roster reviews their recorded sessions:
1. It names a suspect setup.
2. It replays the suspect's real past tasks under candidate setups.
3. It promotes a candidate only if nothing regresses.

We test whether that decision holds on new work that didn't exist when the decision was made.

- **H1 (primary):** on the forward backlog, the setup Roster promotes passes more tasks than the setup it demotes.
  - Test: McNemar exact over paired tasks, two-sided, α = 0.05.
- **H2 (secondary):** the promoted setup's cost per task is no higher than the demoted setup's.
  - Test: Wilcoxon signed-rank over the paired costs.

## Design
- **Build tasks before the review:**
  - Each task has an id `Txx`.
  - Its setup is assigned by a seeded shuffle: seed `20261010`, `random.Random(20261010).shuffle` in Python, over a balanced A/B/C/D pool. The table is below.
  - The first prompt of every session starts with `[roster setup=<id> task=<Txx>]`.
- **Review:** Roster's first review of this repo runs no earlier than 2026-10-11 07:00 IST.
- **Forward backlog:**
  - 40 tasks in `experiments/forward-backlog.md`.
  - The file is committed and its sha256 published before the review run starts.
  - Acceptance tests are written by a separate agent from the task text alone. They're committed under `experiments/acceptance/` before either setup runs.
- **Pairing:** each forward task runs through both setups in separate worktrees from the same `main` commit.
- **Grading:**
  - The grade is acceptance tests + full suite + scope guard.
  - Any model-based diff judge sees the two diffs under random labels.
- **Merge:**
  - A pass beats a fail.
  - If both pass, the blind judge's preference wins.
  - If the judge ties, the pick is random, with the seed logged.
  - Merges use `--no-ff`.
- **Stop rule:**
  - After at least 15 pairs, if the promoted setup has lost at least 3 more discordant pairs than it has won, Roster opens a revert PR.
  - The build continues on the old setup, and the comparison keeps being recorded.
- **Exclusions** (only these, for both setups, each with a written reason):
  - tasks invalidated by an architecture change
  - tasks where both setups fail for environment reasons (failure code F6)
- **Floor:** if fewer than 24 valid pairs are complete by 2026-10-12 08:00 IST, no forward claim is made, and the counts are reported as they are.
- **If Roster promotes nothing:** we report that. The forward run then compares the suspect against the best-ranked alternative, labelled exploratory.
- **Results:** published whatever they show, in `reports/self/forward.json` and on the experiment page.

## Setup C fallback
If Codex CLI isn't installed and logged in by 2026-10-10 19:00 IST, setup C becomes Claude Code + Haiku 5.5 + default rules. That change is recorded under Amendments.

## Assignment table (build tasks T01–T26)

```
T01=A T02=B T03=B T04=C T05=C T06=D T07=C T08=A T09=D T10=A T11=D T12=C T13=B
T14=C T15=B T16=A T17=A T18=D T19=A T20=C T21=A T22=B T23=B T24=D T25=C* T26=D
counts: A 7, B 6, C 6, D 6. T25 (the Codex harness adapter) is pinned to C and is not randomised.
```

Commits prefixed `ops:` or `human:` are operational or human work. They're excluded from every comparison.

## Amendments

### Amendment 1: 2026-10-10 19:00 IST, setup C fallback applied
Codex CLI wasn't installed and logged in by 19:00 IST, so setup C is Claude Code + Haiku 5.5 (`claude-haiku-5-5`) + default rules, as the rule above specified.
- The assignment table is unchanged.
- T25 (the Codex harness adapter) is still built. Its live test is skipped until Codex is available.
- Model ids resolved by `scripts/probe-models.sh` on Claude Code 2.1.296:
  - A → `claude-opus-5-5`
  - B → `claude-sonnet-5-5`
  - C → `claude-haiku-5-5`
  - D → `claude-sonnet-5-5`
