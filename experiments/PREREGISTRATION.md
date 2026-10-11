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
- **F08–F10** finish in the wave-A process (started 10:41), which grades with the pre-T65 grader. Their pairs are recorded with the same frozen acceptance tests and then re-merged under amendment 8. The queue writes to `.roster/forward.db`. *(Corrected 15:41 IST: it started empty at 15:39, instead of seeded. The wave-A session copies all ten wave-A pairs into it after its re-merge. Until then, the queue's stop rule counts only B–D pairs. Every wave-A pair so far is a both-fail, so none of them is discordant.)*
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

### Amendment 11: 2026-10-11 16:20 IST, F11 excluded (environment), not rerun
F11 is excluded for both sides as an environment failure (F6), not rerun:
- Both sides' sessions ended after 1 turn with "API Error: Can't reach the API server (ENOTFOUND)", a network outage on the run host.
- The pair recorded $0 / $0 and both-fail.
- Under the registered exclusion rule ("both setups fail for environment reasons (F6)"), F11 is excluded for both sides.

How it's handled:
- **Not rerun**, so there's no second attempt to choose between.
- **Recorded** in `reports/self/forward-exclusions.json`, and left out of the paired analysis.
- **If the product needs F11's module** (line-level attribution), it will be built as a separate, disclosed task outside the forward run.

### Amendment 12: 2026-10-11 17:35 IST, the forward grader timed out every full-suite run; fixes, regrade, resume
- **What was wrong.**
  - **Suite timeout.** Every grading step ran under the grader's default 5-minute timeout. The full suite takes about 15 minutes on the loaded build machine, so every full-suite run in the forward run was recorded as a failure. That covers wave A under the original grader and the B–D pairs F12 and F15. H1 needs the full suite, so no side could pass H1, whatever its acceptance result.
  - **Grading copy.** The copy added in T66 ran `tar` without pipefail and packed macOS extended attributes. A failed copy went unnoticed and later broke grading with "bad object". That crashed the wave-A re-merge and the B–D queue (17:26).
- **Fixes** (ops commit `cee4921`, excluded from every comparison):
  - each grading step gets a 45-minute timeout
  - forward grading gives bun a 60-second per-test timeout (bun's 5-second default fails tests on timing alone under this load)
  - the copy runs with pipefail and without extended attributes, and is retried once
  - a failing suite re-runs only its failing files (at most 5), once, and passes only if they all pass
  - one pair's error no longer ends a run or a re-merge
  - the forward database waits for a lock instead of failing
- **Regrade.** Every pair recorded before the fix is regraded with `roster forward --remerge --regrade` and the fixed grader. That's wave A (F01–F10 without F11, which amendment 11 excludes) plus F12 and F15. On each agent's recorded branch, the acceptance tests and the full suite run again, pass_old/pass_new are recomputed, and the merge policy is applied. Agents aren't re-run. Each change to H1 is logged as old → new. The H1 definition (acceptance + full suite + scope) is unchanged. The per-test timeout and the one-shot retry change how the suite is run, not what H1 means. They apply identically to both sides and to every pair, and they were set before any regraded result was seen.
- **Resume.** The restarted queue grades F16 and F17, whose two agents had both finished before the crash, from their branches without re-running them. F18's agents were about 12 minutes in. They were stopped, and F18 restarts clean from the current `main`.

### Amendment 13: 2026-10-11 18:00 IST, grading no longer stalls the queue; one branch grades at a time
- **What was wrong.** Grading steps ran as blocking child processes, so while one pair graded (a suite step runs up to 45 minutes) the whole B–D queue process was frozen. No other pair could launch or reap its agents. After the 17:29 restart, F18 and F19 never started while F16 graded. An agent orphaned by the 17:26 crash (F19, setup E) was still writing in F19's worktree. The operator stopped it, and F19 restarts clean.
- **Fixes** (ops commits, excluded from every comparison):
  - `6faa6cc`: grading steps run asynchronously, with the same command and the same 45-minute limit.
  - this commit: every branch the queue grades goes through grading slots. One branch at a time by default (`ROSTER_GRADE_PARALLEL`), which is how grading effectively ran when each step blocked, so suites don't compete with each other for the 45-minute limit. Agents keep launching and finishing while a pair grades.
  - `grade_ms` counts wall time with at least one of the pair's grading steps holding a slot. Time spent waiting for a slot isn't counted.
- **Scope.** H1, the merge policy, the timeouts and the test commands are unchanged. The change applies identically to both sides and every pair. No B–D pair has been recorded under the fixed grader: F12 and F15 are being regraded under amendment 12, and F16/F17 had not finished grading when the queue was stopped at 17:54. The queue restarts from the same command, and F16/F17 resume from their branches.
- **Side effect disclosed.** While stopping the queue at 17:54, the operator killed stray grading processes (`roster-grade-*/work`). A typecheck running in a concurrent re-merge sandbox may have been killed. A typecheck counts only toward amendment 8 merge candidacy, never H1, and any pair re-merged in that window whose result shows a typecheck failure gets its `--remerge --regrade` run again.

### Amendment 14: 2026-10-11 21:05 IST, suites failed under machine overload; one final logged regrade for sides that passed acceptance and failed the suite
- **What happened.** From 17:29 the build machine (8 GB) ran at load 105–291. Up to ~9 full test suites ran at once: the queue, two regrades with no grading slots, review-1b's replays, and E agents running the suite themselves. The full suite takes ~14 minutes at moderate load. Under this load it can pass the 45-minute step limit, and timing-sensitive tests fail. The grader didn't record why a suite failed. In this period, sides that passed acceptance and then failed the full suite are:
  - F02 (both sides), F06 (both) and F15 (both), from the regrades;
  - F19's old side (B), from the queue. F19 graded for 107 minutes and merged new.
- **Diagnostic, disclosed.** At 19:05–19:20 (load ~89) the operator ran F15's E branch (`forward/F15/new`) through the full suite once, outside the grader, in a scratch copy, with the grader's command (`bun test --timeout 60000`). Result: 602 tests, 0 failures, 14.4 minutes. No other branch was run this way, and no recorded result was changed by it.
- **Fixes** (ops commit, excluded from every comparison):
  - **Failure logging.** Every failed suite is logged as `forward: <task>: <side> suite failed: <files>`, naming the test files still failing after the retry, or saying that the run left no JUnit (killed, timed out or crashed).
  - **Regrade grading slots.** `roster forward --remerge` grades through the same grading slots as the queue: one branch at a time by default (`ROSTER_GRADE_PARALLEL`). Previously a regrade at `--parallel 2` could run four suites at once.
  - **H1-only regrade of merged pairs.** A merged pair named with `--tasks` under `--regrade` has its H1 regraded. Both sides are graded from the commit where its two branches meet, and its merge is left as it is.
- **Rule.**
  - **Which sides.** Every side that passed acceptance and failed the full suite in a grading run without failure logging gets one more `--remerge --regrade` of its pair on this code. That's F02, F06, F15 and F19 so far, plus any such side the running queue records before it restarts on this code.
  - **Final result.** That regrade's H1 is final for the pair, pass or fail, and it's recorded with its failure log.
  - **Merges.** Merges stay as they are; they are build progress (amendment 8), not H1.
  - **Other pairs.** A side that failed acceptance, or whose suite passed, keeps its result.
  - **Fixed before results.** The rule was fixed before any of these regrades produced a result. An F02/F06 regrade started at 19:11 was stopped at 19:20 with nothing recorded, because it ran without slots at load 291.
- **Scope.** H1 (acceptance + full suite + scope), the timeouts, the retry and the test commands are unchanged. Both sides of each pair are regraded identically.

### Amendment 15: 2026-10-11 23:20 IST, suites still killed at the 45-minute limit; 90-minute limit, machine-wide grading slot, one regrade for every suite that left no JUnit
- **What happened.** With amendment 14's failure logging in place, the queue logged `F20: new suite failed: no JUnit (killed, timed out or crashed)` at about 45 minutes. F20 then recorded old pass, new fail and merged old. At that time the machine (load 110–240) was running the queue's grading, the F02/F06 regrade's grading (a separate process with its own slot), and the agents' own test runs. The suite takes ~14 minutes at moderate load, so this was the step limit, not the change.
- **Fixes** (ops commit, excluded from every comparison):
  - **Step limit.** Each grading step's limit goes from 45 to 90 minutes (`ROSTER_GRADE_TIMEOUT_MS`).
  - **One slot machine-wide.** `roster forward` and `roster forward --remerge` share their grading slots through a lock directory (`ROSTER_GRADE_LOCK_DIR`, default `$TMPDIR/roster-grade-slots`). The queue and every regrade together grade one branch at a time, where before each process had its own slot. A slot whose holder process is gone is taken over.
- **Rule.**
  - **Which pairs.** Every pair with a side whose suite left no JUnit under the 45-minute limit gets one more `--remerge --regrade` on this code, and that regrade is final. That's F20 so far, plus any such side logged before the queue and the running regrades restart on this code.
  - **Merges.** A merged pair (F20) gets an H1-only regrade, and its merge stays (amendment 14).
  - **Overrides amendment 14.** A suite that leaves no JUnit is not a measurement, so it doesn't count as amendment 14's final regrade; that pair gets one more under this rule.
  - **Fixed before results.** The rule was fixed after seeing F20's logged failure and before any regrade under it.
- **Scope.** H1, the retry and the test commands are unchanged. The rule applies to both sides and every pair.

### Amendment 16: 2026-10-12 01:13 IST, fair turns at the shared grading slot; two slots
- **What happened.** After amendment 15 the queue held the single machine-wide grading slot from 23:18 to 01:10. Each time it released the slot it took it straight back for its next step, before any other process polled. So the regrades under amendments 14 and 15 (F06, F01/F04/F05/F08/F09/F10, F02, F15/F19/F20) graded nothing in that time. Load was down to 8–40.
- **Fixes** (ops commit, excluded from every comparison):
  - **Fair turns.** Waiters for the shared slots take tickets and are served first come, first served across processes. A ticket left by a process that is gone is dropped.
  - **Two slots.** Grading slots go from 1 to 2 (`ROSTER_GRADE_PARALLEL`). With the 90-minute step limit (amendment 15), two concurrent suites fit comfortably at the current load, and a single slot made grading the bottleneck of the whole run.
- **Scope.**
  - H1, the step limit, the retry, the test commands and amendments 14–15's regrade rules are unchanged.
  - Every failed suite is still logged. A suite that leaves no JUnit under the 90-minute limit is recorded as logged and is final.
- **Restarts.** The queue and all regrades restart on this code. Only F28's agents, started minutes earlier, are re-run. F25–F27 resume from their branches.

### Amendment 17: 2026-10-12 02:08 IST, F06 build-only merge (H1 unchanged)
- **F06's final logged regrade** (amendments 14 and 15) failed the full suite on both sides, each at `tests/agent-backend.test.ts`. F06's branches sit on the 10:40 base, before that test was fixed (T63/T64); it passes on current main. A real file was named, so the result stands and is final: both sides fail H1, and nothing merges under the registered policy.
- **Why merge anyway.** F07 and F13 build on F06's Book type. Without F06 on main, both sides of those pairs would start without a dependency the frozen backlog assumes.
- **The build-only merge.**
  1. The operator takes F06's secondary-preferred side (old, B).
  2. Current main is merged into that branch, with a `human:` commit for any conflict resolution.
  3. The full suite and the typecheck are run on the result.
  4. If both pass, it's merged to main as `F06: build-only merge (B), H1 unchanged`.
- **What doesn't change.** F06's recorded H1, its merged field (null) and every other recorded field stay as they are. The merge is build progress like amendment 8's, excluded from every comparison. It is on main before F07, F14 or F13 start, so both sides of those pairs start from the same main.
- **If the suite or typecheck fails,** nothing merges, and F07 and F13 move to the end of the queue under the next amendment.
