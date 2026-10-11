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

### Amendment 2: 2026-10-10 19:40 IST, candidate setups run on DeepSeek; Roster's own model calls go to DeepSeek
This was decided before any review ran.
- **Control vs candidates.** The original setups (A–D) are replayed exactly as they are, as the control. Every candidate Roster proposes runs the Claude Code harness against DeepSeek's Anthropic-compatible endpoint:
  - `setups/candidates/E.json`: `deepseek-flash`
  - `setups/candidates/F.json`: `deepseek-v4-pro`
  - Rules-file variants of either, generated from failure codes.
- **H1 is unchanged in form.** The forward run pairs the demoted setup with the promoted candidate.
- **H2 (cost) uses time-of-day pricing.** DeepSeek publishes peak and off-peak rates, so each run is priced at the rate for its own timestamp.
- **Roster's own reasoning uses DeepSeek** through its OpenAI-compatible API. That covers the coordinator, the blind diff-judge and the acceptance-test writer. No Claude API is used by the product itself.
- **T25** was pinned to C and never randomised. It now builds DeepSeek provider support for the harness and the price table instead of a Codex adapter.

### Amendment 3: 2026-10-10 20:25 IST, how setup D's rules are delivered, and integration tasks
This was decided before any review ran.
- **Setup D's strict rules move.** Until now they were appended to the system prompt. From T17 on they're written to a gitignored `CLAUDE.local.md` in D's worktree. The rules text is unchanged.
- **Why:** Roster's first observational run couldn't tell B and D apart. The appended prompt isn't recorded in the session transcript, so it inferred 3 setups for our 4. In the sessions it scored, that made setup inference match the prompt tags in 82.4% of them, all at that point.
- **The earlier D sessions:** T06, T09 and T11 keep their prompt tags as ground truth.
- **Integration tasks** found during the build are numbered T27 and up. Their setups come from a second seeded shuffle (seed `20261011`, a balanced pool of 16), taken in order:
  `T27=B T28=D T29=D T30=C T31=C T32=A T33=B T34=B T35=A T36=C T37=A T38=A T39=C T40=D T41=B T42=D`.

### Amendment 4: 2026-10-10 21:05 IST, protocol deviation, T18 and T28 ran without setup D's strict rules
Under amendment 3, D's rules were written to `CLAUDE.local.md`. Sessions ran with `--setting-sources project`, which silently skips `CLAUDE.local.md`. We confirmed this with a one-question probe: the file loads only with `project,local`.
- **Affected:** T18 and T28 (assigned D) ran with the default rules only. That's B's configuration on D's model.
- **Unaffected:** T06, T09 and T11 got the strict rules through the appended system prompt.
- **How T18 and T28 are analysed:**
  - excluded from every D comparison
  - reported in a sensitivity analysis as B-configured sessions
  - their tags stay as recorded
- **The fix:** sessions now run with `--setting-sources project,local`. No other session is affected.
- **Who found it:** Roster's own setup inference, which kept merging B and D into one setup.

### Amendment 5: 2026-10-10 22:48 IST, forward backlog frozen
- **Frozen:** the forward backlog and its 40 acceptance tests are committed. Hashes are in `experiments/FREEZE.txt`.
- **Backlog sha256:** `ac682b239225a99f45ffb347e1e73aa6fe1aec3159abb0ea928ffa6ffc3c63c7`
- **Acceptance tests:** 40 task test files are pre-registered, one for each of F01–F40.

### Amendment 6: 2026-10-10 23:54 IST, integration task assignments T43 and up
The amendment 3 block (T27–T42) is used up. Integration tasks T43 and up take setups from a third seeded shuffle (seed `20261012`, a balanced pool of 24), in order:
`T43=D T44=B T45=D T46=B T47=A T48=C T49=A T50=D T51=D T52=C T53=A T54=D T55=C T56=A T57=C T58=D T59=C T60=A T61=B T62=B T63=C T64=B T65=A T66=B`.

### Amendment 7: 2026-10-11 10:40 IST, the first review's decision, disclosed before the forward run
- **The decision.** Review 1 (`reports/self/review-1/`, 10:39 IST) found no level-A suspect (OR 4.23, 95% CI 0.40–45.2, p = 1). The coordinator compared incumbent B (Claude Code + Sonnet 5.5) with candidates E and F on 12 of B's past tasks. The gate promoted **E** (Claude Code on DeepSeek Flash).
- **Why the gate promoted E.** E and B tied on hidden tests. Each passed the same 2 tasks, which have no hidden tests, and failed all 10 tasks that do. So the tie-break applied: cheaper wins, $0.44 against $2.52.
- **What that means.** The level-B evidence for this promotion carries **no quality signal**. Even the incumbent passed 0 of 10 hidden-test tasks when replaying its own work, so the replay's hidden-test measure is degenerate. The likely cause is a replay bug (the original session's helper files aren't copied with the hidden tests). It's being fixed for future reviews.
- **No re-review.** The decision is not re-run. Re-running after seeing a result would be a forking path.
- **The forward run** tests the decision as made: **OLD = B, NEW = E**, on the frozen backlog, with the frozen acceptance tests, which are independent of the replay bug.

### Amendment 8: 2026-10-11 11:40 IST, the frozen acceptance tests are over-specified; merge policy for build progress
- **What we found.** After 3 of 40 pairs (F01–F03), both sides fail the frozen acceptance tests in every pair. The failures are mostly exact-string details, for example a test expecting "stop and report …" while the implementation writes "Stop and report …".
- **The primary metric doesn't change.** H1, pass/fail on the frozen acceptance tests, stays as registered. Results are reported as they come, including if most pairs end both-fail.
- **Merge policy, for the build only (it isn't a measured outcome):**
  - If both sides fail acceptance, the side that passes its full suite with scope OK is merged.
  - If both do, the blind diff-judge picks.
  - If neither does, nothing is merged.
- **Secondary outcome (exploratory, defined now after 3 pairs).** It's the blind judge's preference among the sides that pass their suite and scope. It's reported separately and never as H1.

### Amendment 9: 2026-10-11 14:05 IST, one guardrail line added for all sessions
Twice now, a headless session ended without committing: T26 and T64 each started a background command and then waited for a notification that can't arrive. From now on the shared guardrails (`scripts/guardrails.txt`) include: "Never start a command in the background or wait for a notification … run tests and builds in the foreground, then commit." The line reaches both sides of every forward pair launched after this commit. Pairs F01–F05 ran without it.

### Amendment 10: 2026-10-11 14:51 IST, waves B–D run as one queue; faster grading; T66 setup deviation; assignments T67 and up
- **One queue instead of three waves.** The frozen backlog says tasks run in four waves and depend only on earlier waves. From F12 on, waves B–D run as one queue at `--parallel 4`, in frozen order, except that F13 (the book command) moves to the end because it uses F06 and F07. F07 and F14 start only after wave A is re-merged under amendment 8, so F06, F02 and F03 can be on `main`. The task blocks and their acceptance tests aren't changed (backlog sha256 unchanged: `ac682b23…3c63c7`).
- **What this changes, and what it doesn't.** Both sides of a pair still start from the same `main` commit, so the pairing is unchanged. A later-wave task may now start before an earlier-wave task has merged, so it can see a different `main` than the wave plan intended. That holds equally for both sides.
- **F08–F10** finish in the wave-A process (started 10:41), which grades with the pre-T65 grader. Their pairs are recorded with the same frozen acceptance tests and then re-merged under amendment 8. The queue writes to `.roster/forward.db`, seeded from `.roster/roster.db`. The F08–F10 pairs are copied into it when the wave-A process ends. Until then, the queue's stop rule doesn't count them.
- **Grading (T66).** Every pair records each side's acceptance result, scope and typecheck. The full suite then runs only where it can change an outcome:
  - On any side that passes acceptance with scope OK. H1 keeps its registered definition: acceptance + full suite + scope. Typecheck and a side's own new tests never change H1. *(Corrected 15:05 IST, before any pair was graded under this amendment: the 14:51 text also required typecheck here, which would have changed H1.)*
  - On the merge candidate, under amendment 8's build-only policy.
  - A side whose suite isn't run is recorded as "not run" (null), never as a pass or a fail.
  - Under amendment 8, when both sides fail acceptance, a side is a merge candidate if its own new tests and typecheck pass with scope OK. If both qualify, the blind judge's preferred side is tried first. A candidate merges only if its full suite passes; otherwise the next candidate is tried.
- **Secondary outcome (exploratory; amendment 8), redefined before any pair is graded under it:** the blind judge's preference among sides whose own new tests and typecheck pass with scope OK. The full suite no longer runs on both sides, so it can't be the filter.
- **Stop rule under parallelism.** When the rule triggers, up to 3 other pairs may still be in flight. They're recorded and counted like any other pair.
- **Protocol deviation: T66.** Amendment 6 assigns T66 to B, but it was launched under D. It's analysed under D, the setup it actually ran under.
- **Assignments T67 and up.** The amendment 6 pool ends at T66. Integration tasks T67 and up take setups from a fourth seeded shuffle (seed `20261013`, `random.Random(20261013).shuffle` over a balanced pool of 24), in order:
  `T67=C T68=C T69=A T70=B T71=B T72=A T73=D T74=D T75=A T76=A T77=A T78=B T79=B T80=D T81=A T82=B T83=B T84=D T85=D T86=C T87=C T88=C T89=C T90=D`.
- **Forward costs.** Forward pairs so far record each side's cost from Claude Code's own dollar figure, which prices setup E's DeepSeek tokens at Claude rates. Before any forward cost is reported (H2), every pair is re-priced from its token usage with the same pricing as the replay path (T67). Both figures are kept in the re-pricing log.
