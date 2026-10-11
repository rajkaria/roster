# Rules library

Maps a failure code from the taxonomy (`DESIGN.md` §"Grade", `src/types.ts` `FailureCode`) to one rule that a
rules-file candidate adds to the setup that produced it. `src/candidates/index.ts` reads the table below and
appends the matching rules under `## Added by Roster`, each one citing the codes it answers.

The rule text is copied verbatim into the rules file, so it has to stand alone: imperative, one line, no
reference to the failure code's name and no number that goes stale.

| Code | Rule |
| --- | --- |
| F1 | never modify existing tests unless asked |
| F2 | run the full test suite before finishing |
| F4 | finish the whole task and list anything skipped |
| F5 | stop and report instead of retrying the same failing step more than twice |
| F7 | touch only files the task needs |

F3 (suite regression) and F6 (environment or setup error) add no rule and are deliberately absent from the
table. F6 is excluded and resampled rather than retried, so no rule can answer it; F3 is already the outcome
the harness measures, and telling the agent "do not regress the suite" duplicates F2 without adding an
instruction it can act on differently.

Adding a rule for a code means editing the table only: the parser reads this file at run time.
