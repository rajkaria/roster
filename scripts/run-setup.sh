#!/usr/bin/env bash
# Launch one build task under one agent setup, in its own git worktree.
#
#   scripts/run-setup.sh <setup A|B|C|D> <task Txx>
#
# env  ROSTER_TASKS  path to the task-block file (required). A block is the text
#                    between "<!-- Txx -->" and "<!-- /Txx -->"; its first line must be
#                    the tag "[roster setup=<setup> task=<Txx>]".
#      ROSTER_WT     worktree root (default: /Users/Shared/roster-wt). It must not sit under $HOME:
#                    Claude Code loads <ancestor>/.claude/CLAUDE.md for every ancestor directory, so a
#                    worktree under $HOME would pull the operator's global rules into the session.
#      ROSTER_DRY=1  print what would run, run nothing
#      ROSTER_CLAUDE_CONFIG  isolated Claude Code config dir (default: ~/.roster-claude). Keeps the
#                    operator's global CLAUDE.md, plugins and hooks out of every setup and out of the
#                    public session transcripts. Log in once: CLAUDE_CONFIG_DIR=~/.roster-claude claude auth login
#
# The tag goes first in the prompt so every recorded session carries its ground-truth
# setup label. Sessions run with project settings only (--setting-sources project), so a
# setup is exactly harness + model + rules, not whatever is in the operator's ~/.claude.
# The script never merges: the operator reviews, runs the suite, then `git merge --no-ff`.
set -euo pipefail

SETUP="${1:?usage: run-setup.sh <setup> <task>}"
TASK="${2:?usage: run-setup.sh <setup> <task>}"
ROOT="$(git rev-parse --show-toplevel)"
CFG="$ROOT/setups/$SETUP.json"
[ -f "$CFG" ] || CFG="$ROOT/setups/candidates/$SETUP.json"
[ -f "$CFG" ] || { echo "run-setup: no setup '$SETUP'" >&2; exit 2; }
TASKS="${ROSTER_TASKS:?run-setup: set ROSTER_TASKS to the task-block file}"
WT_ROOT="${ROSTER_WT:-/Users/Shared/roster-wt}"
WT="$WT_ROOT/$TASK"
BRANCH="task/$TASK"
LOGDIR="$ROOT/.roster/runs"
mkdir -p "$LOGDIR" "$WT_ROOT"

harness="$(jq -r .harness "$CFG")"
model="$(jq -r .model "$CFG")"
append="$(jq -r '.append_rules // empty' "$CFG")"

block="$(awk -v s="<!-- $TASK -->" -v e="<!-- /$TASK -->" '$0==s{f=1;next} $0==e{f=0} f' "$TASKS")"
[ -n "$block" ] || { echo "run-setup: task $TASK not found in $TASKS" >&2; exit 2; }
tag="$(printf '%s\n' "$block" | head -n 1)"
if [ "$tag" != "[roster setup=$SETUP task=$TASK]" ]; then
  echo "run-setup: tag mismatch: '$tag' (expected setup=$SETUP task=$TASK)" >&2
  exit 3
fi
PROMPT="$tag

$(cat "$ROOT/scripts/guardrails.txt")

$(printf '%s\n' "$block" | tail -n +2)"

LOG="$LOGDIR/$TASK.$SETUP.jsonl"
ERR="$LOGDIR/$TASK.$SETUP.err"
# Host-session plumbing must not leak into the child (it would join the parent session).
SCRUB=(-u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_ENTRYPOINT
       -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN)

# Provider env from the setup file (e.g. DeepSeek candidates). ${VAR} values are filled from
# the repo's .env. Secrets reach the child process only, never the prompt or a log line.
PROVIDER_ENV=()
if jq -e '.env' "$CFG" >/dev/null 2>&1; then
  if [ -f "$ROOT/.env" ]; then set -a; . "$ROOT/.env"; set +a; fi
  while IFS=$'\t' read -r k v; do
    case "$v" in
      '${'*'}') var="${v:2:${#v}-3}"; v="${!var:-}"
                [ -n "$v" ] || { echo "run-setup: $var is not set (.env)" >&2; exit 4; } ;;
    esac
    PROVIDER_ENV+=("$k=$v")
  done < <(jq -r '.env | to_entries[] | "\(.key)\t\(.value)"' "$CFG")
fi
CONFIG_DIR="${ROSTER_CLAUDE_CONFIG:-$HOME/.roster-claude}"
if [ "$(jq -r '.provider // "anthropic"' "$CFG")" != "anthropic" ]; then
  CONFIG_DIR="${CONFIG_DIR}-$(jq -r .provider "$CFG")"   # separate config: no OAuth session mixed in
  mkdir -p "$CONFIG_DIR"
fi

case "$harness" in
  claude-code)
    # The allowlist is passed on the command line too: Claude Code ignores a project's
    # permissions.allow until the workspace is trusted, and a headless run can't accept the dialog.
    allowed="$(jq -r '.permissions.allow | join(",")' "$ROOT/.claude/settings.json")"
    denied="$(jq -r '.permissions.deny | join(",")' "$ROOT/.claude/settings.json")"
    args=(-p "$PROMPT" --model "$model" --output-format stream-json --verbose
          --max-turns 150 --permission-mode acceptEdits
          --allowedTools "$allowed" --disallowedTools "$denied"
          --setting-sources project --strict-mcp-config)
    if [ -n "$append" ]; then args+=(--append-system-prompt "$(cat "$ROOT/$append")"); fi
    cmd=(claude "${args[@]}")
    ;;
  codex)
    args=(exec --json --sandbox workspace-write -c approval_policy=never -C "$WT")
    if [ "$model" != "default" ]; then args+=(-m "$model"); fi
    cmd=(codex "${args[@]}" "$PROMPT")
    ;;
  *) echo "run-setup: unknown harness '$harness'" >&2; exit 2 ;;
esac

if [ "${ROSTER_DRY:-0}" = "1" ]; then
  printf 'worktree: %s (branch %s)\nlog: %s\ncommand:' "$WT" "$BRANCH" "$LOG"
  printf ' %q' "${cmd[@]:0:1}" "${cmd[@]:2}"; printf '\n--- prompt (%d chars) ---\n%s\n' "${#PROMPT}" "$PROMPT" | head -20
  exit 0
fi

if [ ! -d "$WT" ]; then
  git -C "$ROOT" worktree add -q "$WT" -b "$BRANCH" main
fi
(cd "$WT" && bun install --frozen-lockfile >/dev/null 2>&1 || true)
if [ -f "$ROOT/scripts/ledger.ts" ]; then
  (cd "$ROOT" && bun scripts/ledger.ts record "$TASK" "$SETUP" "$BRANCH") || true
fi

started="$(date +%s)"
set +e
(cd "$WT" && env "${SCRUB[@]}" CLAUDE_CONFIG_DIR="$CONFIG_DIR" "${PROVIDER_ENV[@]}" "${cmd[@]}") </dev/null >"$LOG" 2>"$ERR"
code=$?
set -e
secs=$(( $(date +%s) - started ))

summary="$(grep '"type":"result"' "$LOG" 2>/dev/null | tail -n 1 | jq -c '{is_error, num_turns, total_cost_usd, duration_ms}' 2>/dev/null || true)"
echo "run-setup: $TASK setup=$SETUP exit=$code ${secs}s ${summary:-no result event (see $ERR)}"
echo "run-setup: review $WT, then: git merge --no-ff $BRANCH"
exit "$code"
