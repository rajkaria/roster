# Roster: rules for every coding agent in this repo

Roster is an agent that runs performance reviews for AI coding agents. The design contract is `docs/DESIGN.md`. Read the sections your task names before you write code.

## Stack
- TypeScript (strict) on Bun. Tests: `bun test`. Typecheck: `bun run typecheck`.
- The web app lives in `web/` (Next.js) and has its own `package.json`.
- State lives in `bun:sqlite` under `.roster/`, which is gitignored.
- `reports/` and `docs/FACTS.md` are generated. Never hand-edit a number in them.

## Working rules
- **Scope:** do only your task, and touch only the files it owns. Shared types live in `src/types.ts`. Change them minimally, and say so when you finish.
- **Tests:** write tests for what you build. Your tests must pass, and the whole suite must not regress.
- **Fixtures:** build them with scripts from real samples (`tests/fixtures/`). Never invent payloads.
- **Commits:**
  - Commit in small steps as work lands, with the message prefix `<task id>: `.
  - Never rewrite history, squash or force-push.
  - Never commit secrets, `.env*` files or tokens. Session transcripts for this repo are public.
- **Docs:** never claim anything that doesn't exist. Numbers appear only in `docs/FACTS.md`, which is generated.
- **Before editing an existing module:** if `entire graph` is available, run `entire graph impact --symbol <name> --json`.
- **When you finish:** give a short summary covering what you built, the test output, any `src/types.ts` change, and anything unfinished.
