# Forward queue for waves B-D (amendment 10)

Every block below is copied byte-for-byte from `experiments/forward-backlog.md` (sha256 ac682b239225a99f45ffb347e1e73aa6fe1aec3159abb0ea928ffa6ffc3c63c7).
Only the order differs. F07 and F14 come after 17 other tasks, so wave A's re-merge (F06, F02, F03) is on main before they start. F13 is last because it uses F06 and F07.

<!-- F12 -->
[roster setup={SETUP} task=F12]
## F12: Attribution accuracy
TASK F12 · Attribution accuracy
GOAL: Measure how often attribution names the right session or setup.
OWNS: src/attribution/evaluate.ts, tests/attribution-eval.test.ts
INTERFACE: src/attribution/evaluate.ts function attributionAccuracy(pred: { id: string; predicted: string }[], key: { id: string; actual: string }[]): { correct: number; total: number; accuracy: number; missing: string[] }; tagAccuracy(rows: { inferredSetup: string | null; tag: string | null }[]): { correct: number; total: number; accuracy: number }
BEHAVIOUR: total = key entries; a key id absent from pred is wrong and listed in missing; accuracy rounded to 4 decimals, 0 when total
0. tagAccuracy counts only rows with a tag; inferred clusters are mapped to tags by majority vote first, then compared.
<!-- /F12 -->

<!-- F15 -->
[roster setup={SETUP} task=F15]
## F15: Experiment page
TASK F15 · Experiment page
GOAL: A public page showing the pre-registration and the forward run as it fills in.
OWNS: web/app/experiment/page.tsx, web/lib/forward.ts, tests/web-forward.test.ts
INTERFACE: web/lib/forward.ts function loadForward(json: unknown): { rows: { task: string; old: boolean; new: boolean; costOld: number | null; costNew: number | null; excluded?: string }[]; summary: { n: number; wording: string } | null }
BEHAVIOUR: The page reads public/data/self/forward.json (absent → empty state "The forward run has not started"). Shows the backlog
sha256 from public/data/self/prereg.json if present, a link to experiments/PREREGISTRATION.md on GitHub, the pair table, and the
summary wording verbatim. loadForward rejects malformed rows (skips them and counts them in a `skipped` field on summary).
<!-- /F15 -->

<!-- F16 -->
[roster setup={SETUP} task=F16]
## F16: Book page
TASK F16 · Book page
GOAL: A public page showing the AI-workforce department and the hire-vs-scale scenario.
OWNS: web/app/book/page.tsx, web/lib/book.ts, tests/web-book.test.ts
INTERFACE: web/lib/book.ts function loadBook(json: unknown): { rows: { setup: string; label: string; monthly: string; perChange: string; unattended: string }[]; scenario: { hire: string; scale: string } | null; shareUrl: string | null }
BEHAVIOUR: Money formatted "$1,234.56", null → "n/a", percent "42.0%". Reads public/data/self/book.json; absent → empty state. Shows a
"View in cfo.ai" link only when shareUrl is an https URL on cfo.ai.
<!-- /F16 -->

<!-- F17 -->
[roster setup={SETUP} task=F17]
## F17: Paste-a-repo API route
TASK F17 · Paste-a-repo API route
GOAL: Accept a GitHub repo URL from the public page, validate it, rate-limit, and serve cached reviews.
OWNS: web/app/api/review/route.ts, web/lib/try.ts, tests/web-try.test.ts
INTERFACE: web/lib/try.ts function parseRepoUrl(input: string): { owner: string; repo: string } | null; createLimiter(opts: { perMinute: number }): { take(key: string, now: number): boolean }
BEHAVIOUR: Accepts https://github.com/<owner>/<repo>(.git)?(/)? and owner/repo; rejects other hosts, extra path segments, and names
outside GitHub's allowed characters. Limiter is a per-key token bucket. Route: POST {repo} → 400 on invalid, 429 when limited, 200 with
{cached: true, path} when public/data/r/<owner>/<repo>/review.json exists, else 202 {queued: true}.
<!-- /F17 -->

<!-- F18 -->
[roster setup={SETUP} task=F18]
## F18: MicroVM runner adapter
TASK F18 · MicroVM runner adapter
GOAL: Run a command for a public repo inside an isolated sandbox VM, never on the host.
OWNS: src/sandbox/microvm.ts, tests/microvm.test.ts
INTERFACE: src/sandbox/microvm.ts function runInMicroVm(opts: { repoUrl: string; command: string[]; timeoutMs: number; files?: Record<string, string> }, client: { create(): Promise<{ id: string }>; exec(id: string, cmd: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }>; write(id: string, path: string, content: string): Promise<void>; stop(id: string): Promise<void> }): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>
BEHAVIOUR: create → write files → exec `git clone --filter=blob:none <repoUrl> /work` then the command in /work → stop. stop is always
called, including after errors and timeouts. A timeout returns timedOut true and code 124. Rejects non-https repo URLs before creating
anything.
<!-- /F18 -->

<!-- F19 -->
[roster setup={SETUP} task=F19]
## F19: Public corpus runner
TASK F19 · Public corpus runner
GOAL: Review the top public repos from the corpus candidates and keep going when one fails.
OWNS: scripts/corpus-run.ts, tests/corpus-run.test.ts
INTERFACE: scripts/corpus-run.ts function runCorpus(opts: { candidates: { repo: string; score: number }[]; top: number; review: (repo: string) => Promise<unknown>; write: (path: string, data: unknown) => Promise<void> }): Promise<{ done: string[]; failed: { repo: string; reason: string }[] }>
BEHAVIOUR: Takes the `top` highest-score candidates (ties broken by repo name), reviews them sequentially, writes
reports/corpus/<owner>__<repo>/review.json for each success and reports/corpus/index.json at the end with done and failed lists. A
throwing review is recorded with its message and does not stop the run.
<!-- /F19 -->

<!-- F20 -->
[roster setup={SETUP} task=F20]
## F20: Corpus table
TASK F20 · Corpus table
GOAL: One row of numbers per public repo, with totals that add up.
OWNS: src/review/corpus-table.ts, tests/corpus-table.test.ts
INTERFACE: src/review/corpus-table.ts function buildCorpusTable(reviews: { repo: string; sessions: number; setups: number; costUsd: number | null; suspect: string | null; replayed: number; promoted: string | null }[]): { rows: typeof reviews; totals: { repos: number; sessions: number; costUsd: number | null; replayed: number; promotions: number } }
BEHAVIOUR: Rows sorted by sessions descending then repo. costUsd total is null if every row is null, otherwise the sum of non-null rows.
promotions counts rows with promoted non-null. Totals must equal the sums of the rows (a test re-adds them).
<!-- /F20 -->

<!-- F21 -->
[roster setup={SETUP} task=F21]
## F21: README results from FACTS
TASK F21 · README results from FACTS
GOAL: Keep the README's results section generated from docs/FACTS.md so nobody types a number.
OWNS: scripts/readme-facts.ts, tests/readme-facts.test.ts
INTERFACE: scripts/readme-facts.ts function renderResults(readme: string, facts: string, keys: string[]): string
BEHAVIOUR: Replaces the text between `<!-- facts:start -->` and `<!-- facts:end -->` with one bullet per key: "<KEY>: <value>" where
the value is taken from a FACTS line `KEY = value  (source: …)`. A missing key or a PENDING value renders "pending". Markers absent →
README returned unchanged. Running twice is idempotent.
<!-- /F21 -->

<!-- F22 -->
[roster setup={SETUP} task=F22]
## F22: `roster status` command
TASK F22 · `roster status` command
GOAL: Show where a run is: last step, pending steps, budget used.
OWNS: src/cli/status.ts, tests/cli-status.test.ts
INTERFACE: src/cli/status.ts function renderStatus(events: { runId: string; step: string; status: 'started' | 'done' | 'failed'; at: string; costUsd?: number }[], budgetUsd: number): string
BEHAVIOUR: For the latest runId: last completed step, any started-not-done step marked "in progress", failed steps listed, cost used vs
budget as "$x.xx of $y.yy". No events → "no runs yet".
<!-- /F22 -->

<!-- F23 -->
[roster setup={SETUP} task=F23]
## F23: Resume a run without repeating steps
TASK F23 · Resume a run without repeating steps
GOAL: After a crash, continue from the next unfinished step and never run a finished step twice.
OWNS: src/agent/resume.ts, tests/resume.test.ts
INTERFACE: src/agent/resume.ts function nextSteps(plan: { steps: { key: string; dependsOn: string[] }[] }, events: { key: string; status: 'started' | 'done' | 'failed' }[]): string[]
BEHAVIOUR: Returns keys whose dependencies are all done and which are not done themselves, in plan order. A step that started but
didn't finish is returned again. A failed step is returned again unless it has failed 3 times, after which it is excluded and its
dependents are not returned.
<!-- /F23 -->

<!-- F24 -->
[roster setup={SETUP} task=F24]
## F24: Budget guard
TASK F24 · Budget guard
GOAL: Hard spend caps per run and per task, safe under concurrency.
OWNS: src/harness/budget.ts, tests/budget.test.ts
INTERFACE: src/harness/budget.ts class BudgetGuard { constructor(runCapUsd: number, taskCapUsd: number); reserve(task: string, usd: number): Reservation; used(): number; remaining(): number } ; Reservation { commit(actualUsd: number): void; release(): void } ; class BudgetExceeded extends Error
BEHAVIOUR: reserve throws BudgetExceeded if reserved + used + usd > runCap or the task's total would exceed taskCap. commit replaces the
reservation with the actual amount (actual may exceed the reservation; it still counts). release frees it. Double commit/release
throws.
<!-- /F24 -->

<!-- F25 -->
[roster setup={SETUP} task=F25]
## F25: Stratified task sampler
TASK F25 · Stratified task sampler
GOAL: Pick replay tasks across difficulty terciles, deterministically.
OWNS: src/replay/sample.ts, tests/sample.test.ts
INTERFACE: src/replay/sample.ts function sampleTasks(tasks: { id: string; tercile: 1 | 2 | 3; eligible: boolean }[], opts: { max: number; seed: number }): string[]
BEHAVIOUR: Only eligible tasks. Allocates max as evenly as possible across terciles (remainder to the highest terciles first), fills a
short tercile's leftover from the others, picks within a tercile by seeded shuffle. Same input + seed → same output; output sorted by id.
<!-- /F25 -->

<!-- F26 -->
[roster setup={SETUP} task=F26]
## F26: Replay eligibility
TASK F26 · Replay eligibility
GOAL: Decide whether a past task can be replayed fairly, with a reason.
OWNS: src/replay/eligibility.ts, tests/eligibility.test.ts
INTERFACE: src/replay/eligibility.ts function checkEligibility(task: { userPrompts: number; hiddenTests: string[]; strategy: string }, probe: () => Promise<{ installs: boolean; suitePasses: boolean }>): Promise<{ eligible: boolean; track: 'tests' | 'judge-only' | 'none'; reason: string }>
BEHAVIOUR: strategy "import" → none ("imported history"). userPrompts > 2 → none. probe fails to install → none ("parent does not
install"); suite fails at parent → none. No hidden tests → eligible true, track judge-only. Otherwise eligible, track tests. The probe
is not called when an earlier rule already decides.
<!-- /F26 -->

<!-- F27 -->
[roster setup={SETUP} task=F27]
## F27: Blind diff-judge input and output
TASK F27 · Blind diff-judge input and output
GOAL: Make the diff-judge blind to which setup wrote which diff, and parse its answer robustly.
OWNS: src/grade/judge.ts, tests/judge.test.ts
INTERFACE: src/grade/judge.ts function blindPair(a: { setup: string; diff: string }, b: { setup: string; diff: string }, seed: number): { prompt: string; labels: Record<'X' | 'Y', string> }; parseVerdict(text: string, labels: Record<'X' | 'Y', string>): { winner: string | 'tie' | 'unclear' }
BEHAVIOUR: The prompt contains both diffs under labels X and Y and never contains either setup id. Label assignment is a seeded coin
flip. parseVerdict reads a final line "VERDICT: X|Y|TIE" (case-insensitive, last occurrence wins) and maps back to the setup id;
anything else → unclear.
<!-- /F27 -->

<!-- F28 -->
[roster setup={SETUP} task=F28]
## F28: JUnit results with load failures counted
TASK F28 · JUnit results with load failures counted
GOAL: Read per-test results from JUnit XML and never lose a hidden test file that failed to load.
OWNS: src/grade/junit.ts, tests/junit.test.ts
INTERFACE: src/grade/junit.ts function parseJunit(xml: string, expectedFiles: string[]): { tests: { file: string; name: string; pass: boolean }[]; loadFailures: string[] }
BEHAVIOUR: Parses testsuite/testcase elements (file from the testcase or testsuite `file` attribute, else the suite name); a testcase
with <failure> or <error> fails; <skipped> is excluded. Every expected file with zero testcases gets one synthetic failing test named
"0 tests collected: load error" and is listed in loadFailures. No XML dependency beyond the standard library.
<!-- /F28 -->

<!-- F29 -->
[roster setup={SETUP} task=F29]
## F29: Export a run to report files
TASK F29 · Export a run to report files
GOAL: Write a run's review, plan, replays and gate decisions to versioned JSON files.
OWNS: src/report/export.ts, tests/report-export.test.ts
INTERFACE: src/report/export.ts function exportRun(run: { review: unknown; plan?: unknown; replays?: unknown[]; gate?: unknown[] }, outDir: string): Promise<string[]>
BEHAVIOUR: Writes review.json always, and plan.json, replays.json, gate.json when present, each as { schemaVersion: 1, generatedAt,
data }. Writes atomically (temp file + rename). Returns the written paths sorted. Re-export overwrites; generatedAt is the only field
that changes when data is identical.
<!-- /F29 -->

<!-- F30 -->
[roster setup={SETUP} task=F30]
## F30: Report validators
TASK F30 · Report validators
GOAL: Reject malformed report files before they reach the site or FACTS.
OWNS: src/report/validate.ts, tests/report-validate.test.ts
INTERFACE: src/report/validate.ts function validateReport(kind: 'review' | 'forward' | 'book' | 'corpus', json: unknown): { ok: boolean; errors: string[] }
BEHAVIOUR: Checks schemaVersion === 1 and the required fields per kind (review: data.repo, data.setups[] with id; forward:
data.pairs[] with task, passOld, passNew; book: data.department[]; corpus: data.rows[] and data.totals). Errors are JSON-path strings
like "data.setups[2].id: missing". No external dependencies.
<!-- /F30 -->

<!-- F07 -->
[roster setup={SETUP} task=F07]
## F07: Write the book to cfo.ai and verify the read-back
TASK F07 · Write the book to cfo.ai and verify the read-back
GOAL: Write the book through an MCP client and prove what landed matches what was sent.
OWNS: src/cfo/mcp.ts, tests/cfo-mcp.test.ts
INTERFACE: src/cfo/mcp.ts function writeBook(book: Book, client: { call(tool: string, args: Record<string, unknown>): Promise<unknown> }, opts?: { retries?: number }): Promise<{ ok: boolean; attempts: number; diffs: { path: string; sent: unknown; got: unknown }[] }>; diffBook(sent: Book, readback: Book): { path: string; sent: unknown; got: unknown }[] (Book = return type of buildBook in src/cfo/book.ts)
BEHAVIOUR: write via tool "edit_table_blocks", read back via "inspect_table_blocks" (the readback arrives as a Book-shaped object at
result.book; if absent, treat as empty). Numbers compare within 0.005. On diffs, retry the write once (default retries 1), then return
ok false with the diffs. Client errors count as an attempt and are not thrown.
<!-- /F07 -->

<!-- F14 -->
[roster setup={SETUP} task=F14]
## F14: `roster act` command
TASK F14 · `roster act` command
GOAL: Turn the last gate decision into a branch with the promoted setup and a PR (or a dry run).
OWNS: src/cli/act.ts, tests/cli-act.test.ts
INTERFACE: src/cli/act.ts function runActCommand(args: string[], deps: { readJson(p: string): Promise<unknown>; writeFile(p: string, s: string): Promise<void>; git(args: string[]): Promise<{ code: number; stdout: string }>; openPr(o: unknown): Promise<{ opened: boolean; url?: string; reason?: string }>; stdout(s: string): void }): Promise<number>
BEHAVIOUR: `act --gate <gate.json> [--pr] [--dry-run]`. If the decision is not "promote" → prints "nothing to act on", returns 0. Else
writes setups/<id>.json and the candidate rules file to a new branch `roster/promote-<id>`, commits "roster: promote setup <id>", and
with --pr calls openPr (dry-run passes through). Returns 1 if any git step fails.
<!-- /F14 -->

<!-- F31 -->
[roster setup={SETUP} task=F31]
## F31: Nightly review delta comment
TASK F31 · Nightly review delta comment
GOAL: Produce the text Roster posts nightly: what changed since the last review.
OWNS: src/cli/nightly.ts, tests/nightly.test.ts
INTERFACE: src/cli/nightly.ts function nightlyComment(rows: { setup: string; field: string; before: number | null; after: number | null; delta: number | null }[], opts: { repo: string; date: string; threshold: number }): string
BEHAVIOUR: Markdown headed "Roster nightly review: <repo>, <date>"; lists only rows with |delta| ≥ threshold, grouped by setup, with
▲/▼; nothing above threshold → "No changes above <threshold>." Never more than 20 rows (then "+N more").
<!-- /F31 -->

<!-- F32 -->
[roster setup={SETUP} task=F32]
## F32: Existing-setup candidates
TASK F32 · Existing-setup candidates
GOAL: Rank the team's other setups as replacement candidates for a suspect.
OWNS: src/candidates/existing.ts, tests/candidates-existing.test.ts
INTERFACE: src/candidates/existing.ts function rankExisting(setups: { id: string; badRate: number | null; sessions: number; costPerSession: number | null }[], suspect: string, max: number): string[]
BEHAVIOUR: Excludes the suspect and setups with fewer than 3 sessions. Sorts by badRate ascending (null last), then costPerSession
ascending (null last), then id. Returns at most max ids.
<!-- /F32 -->

<!-- F33 -->
[roster setup={SETUP} task=F33]
## F33: Cost statistics per setup
TASK F33 · Cost statistics per setup
GOAL: Per-setup cost totals and spread for the business plan's unit economics.
OWNS: src/report/costs.ts, tests/costs.test.ts
INTERFACE: src/report/costs.ts function costStats(rows: { setup: string; costUsd: number | null }[]): { setup: string; n: number; nullCount: number; totalUsd: number; meanUsd: number | null; p50Usd: number | null; p90Usd: number | null }[]
BEHAVIOUR: Nulls excluded from stats but counted in nullCount. Percentiles by nearest-rank on sorted non-null values. Money rounded to
4 decimals. Output sorted by setup.
<!-- /F33 -->

<!-- F34 -->
[roster setup={SETUP} task=F34]
## F34: Collect all run costs into one file
TASK F34 · Collect all run costs into one file
GOAL: Write reports/costs.json from every report so plans use measured costs only.
OWNS: scripts/costs.ts, tests/costs-script.test.ts
INTERFACE: scripts/costs.ts function collectCosts(files: { path: string; json: unknown }[]): { reviewRuns: number; replayRuns: number; forwardRuns: number; rows: { source: string; setup: string; costUsd: number | null }[] }
BEHAVIOUR: Reads cost fields from replays.json (data[].costUsd with setup), forward.json (data.pairs[] costOld/costNew with the pair's
setups) and review.json (data.setups[].costUsd); counts each kind; unknown files ignored; malformed entries skipped and not counted.
<!-- /F34 -->

<!-- F35 -->
[roster setup={SETUP} task=F35]
## F35: Display formatting for numbers and p-values
TASK F35 · Display formatting for numbers and p-values
GOAL: One place that formats money, percentages and statistical results for every page.
OWNS: web/lib/format.ts, tests/web-format.test.ts
INTERFACE: web/lib/format.ts function usd(n: number | null): string; pct(share: number | null, digits?: number): string; pValue(p: number, n: number): string
BEHAVIOUR: usd → "$1,234.56", negative "−$3.00", null "n/a". pct(0.4213) → "42.1%". pValue: p < 0.001 → "p < 0.001"; else "p = 0.031"
(3 decimals); appends " (not significant at n = N)" when p ≥ 0.05.
<!-- /F35 -->

<!-- F36 -->
[roster setup={SETUP} task=F36]
## F36: Explain a decision in plain words
TASK F36 · Explain a decision in plain words
GOAL: Turn a gate decision or a suspect flag into sentences a founder can read.
OWNS: src/cli/explain.ts, tests/explain.test.ts
INTERFACE: src/cli/explain.ts function explainGate(d: { candidate: string; verdict: 'promote' | 'reject'; reasons: string[]; regressions: string[] }): string; explainSuspect(s: { setupId: string | null; or?: number; p?: number; n: number; reason: string }): string
BEHAVIOUR: Failure codes F1–F7 are spelled out (F1 → "edited existing tests", …). A rejection names each regressed task. A suspect
sentence always contains "suspect" and "observational", never "worse". setupId null → "No setup stands out" plus the reason.
<!-- /F36 -->

<!-- F37 -->
[roster setup={SETUP} task=F37]
## F37: Coordinator prompt as data
TASK F37 · Coordinator prompt as data
GOAL: Keep the coordinator's system prompt and tool descriptions in one checked file.
OWNS: src/agent/prompts.ts, tests/agent-prompts.test.ts
INTERFACE: src/agent/prompts.ts export const SYSTEM_PROMPT: string; export const TOOL_DOCS: Record<string, string>; checkPrompt(registered: string[]): { ok: boolean; missing: string[]; extra: string[] }
BEHAVIOUR: SYSTEM_PROMPT contains the sentences "You decide what to try next. The gate decides what ships." and "Never claim a result
the tools didn't return." and states the budget stops the run. checkPrompt compares TOOL_DOCS keys with the registered tool names.
<!-- /F37 -->

<!-- F38 -->
[roster setup={SETUP} task=F38]
## F38: llms.txt generator
TASK F38 · llms.txt generator
GOAL: Generate llms.txt so reviewers using an AI assistant get an accurate map of the repo.
OWNS: scripts/llms.ts, tests/llms.test.ts
INTERFACE: scripts/llms.ts function renderLlms(input: { readme: string; designHeadings: string[]; facts: string; repoUrl: string }): string
BEHAVIOUR: Output starts with "# Roster", then the README's first blockquote line, a "## Docs" list linking docs/DESIGN.md,
experiments/PREREGISTRATION.md and docs/FACTS.md with absolute GitHub URLs, a "## Design sections" list of the headings, and a "## Facts"
section copied from FACTS lines (PENDING lines kept as PENDING).
<!-- /F38 -->

<!-- F39 -->
[roster setup={SETUP} task=F39]
## F39: Session cache keyed by checkpoint state
TASK F39 · Session cache keyed by checkpoint state
GOAL: Don't re-parse a repo's checkpoints when nothing changed.
OWNS: src/ingest/cache.ts, tests/ingest-cache.test.ts
INTERFACE: src/ingest/cache.ts class SessionCache { constructor(dir: string); key(repo: string, refsDigest: string): string; get(key: string): Promise<unknown[] | null>; set(key: string, sessions: unknown[]): Promise<void> } ; refsDigest(refs: { name: string; sha: string }[]): string
BEHAVIOUR: refsDigest is a sha256 over name=sha lines sorted by name (order-independent). get on a missing or corrupt file → null
(corrupt files are deleted). set writes atomically. Keys are filesystem-safe.
<!-- /F39 -->

<!-- F40 -->
[roster setup={SETUP} task=F40]
## F40: Opt-in registry
TASK F40 · Opt-in registry
GOAL: Only act on other teams' repos when they have opted in, and only in the ways they allowed.
OWNS: src/review/opt-in.ts, tests/opt-in.test.ts
INTERFACE: src/review/opt-in.ts function loadOptIns(json: unknown): { repo: string; public: boolean; prAllowed: boolean; replyUrl?: string }[]; isAllowed(optIns: ReturnType<typeof loadOptIns>, repo: string, action: 'review-public' | 'open-pr'): boolean
BEHAVIOUR: Repo names compared case-insensitively as owner/repo. Unknown repo → false for every action. review-public requires public
true; open-pr requires prAllowed true. Malformed entries are dropped. replyUrl kept only if it is an https URL.
<!-- /F40 -->

<!-- F13 -->
[roster setup={SETUP} task=F13]
## F13: `roster book` command
TASK F13 · `roster book` command
GOAL: Print or write the AI-workforce book from a saved review.
OWNS: src/cli/book.ts, tests/cli-book.test.ts
INTERFACE: src/cli/book.ts function runBookCommand(args: string[], deps: { readJson(path: string): Promise<unknown>; writeBook?: (book: unknown) => Promise<{ ok: boolean }> ; stdout(s: string): void }): Promise<number>
BEHAVIOUR: `book --review <path> [--engineer-usd N] [--scale-sessions N] [--write]`. Without --write prints the book JSON and returns 0.
With --write calls deps.writeBook and returns 0 on ok, 1 otherwise. Missing --review → usage on stdout, return 2. Defaults: engineer
15000, scale sessions 50, period from the review's date range.
<!-- /F13 -->
