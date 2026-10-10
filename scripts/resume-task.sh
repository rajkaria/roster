#!/usr/bin/env bash
# Continue a task's recorded session with one more operator prompt (counted as a user prompt).
#   scripts/resume-task.sh <setup> <task> "<message>"
# Uses the same harness flags and isolation as run-setup.sh; appends to .roster/runs/<task>.<setup>.resume.jsonl.
set -euo pipefail
SETUP="$1"; TASK="$2"; MSG="$3"
ROOT="$(git rev-parse --show-toplevel)"
WT="${ROSTER_WT:-/Users/Shared/roster-wt}/$TASK"
LOG="$ROOT/.roster/runs/$TASK.$SETUP"
sid="$(cat "$LOG".jsonl "$LOG".resume.jsonl 2>/dev/null | grep -o '"session_id":"[^"]*"' | tail -n 1 | cut -d'"' -f4 || true)"
[ -n "$sid" ] || { echo "resume-task: no session id for $TASK" >&2; exit 2; }
CFG="$ROOT/setups/$SETUP.json"; [ -f "$CFG" ] || CFG="$ROOT/setups/candidates/$SETUP.json"
model="$(jq -r .model "$CFG")"
allowed="$(jq -r '.permissions.allow | join(",")' "$ROOT/.claude/settings.json")"
denied="$(jq -r '.permissions.deny | join(",")' "$ROOT/.claude/settings.json")"
(cd "$WT" && env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_MESSAGING_SOCKET \
   -u CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_CONFIG_DIR="${ROSTER_CLAUDE_CONFIG:-$HOME/.roster-claude}" \
   claude -p "$MSG" --resume "$sid" --model "$model" --output-format stream-json --verbose --max-turns 120 \
   --permission-mode acceptEdits --allowedTools "$allowed" --disallowedTools "$denied" \
   --setting-sources project,local --strict-mcp-config) </dev/null >>"$LOG.resume.jsonl" 2>>"$LOG.resume.err"
echo "resume-task: $TASK $(grep '"type":"result"' "$LOG.resume.jsonl" | tail -n 1 | jq -c '{is_error, num_turns, total_cost_usd}')"
