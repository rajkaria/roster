#!/usr/bin/env bash
# Launch several tasks in parallel, one worktree each, and wait for all of them.
#   scripts/wave.sh A:T01 C:T05 D:T09 B:T13 B:T15
# Each pair runs scripts/run-setup.sh; per-task output goes to .roster/runs/<task>.<setup>.wave.
# Prints one summary line per task when everything has finished.
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel)"
mkdir -p "$ROOT/.roster/runs"
[ "$#" -le 5 ] || { echo "wave: at most 5 tasks at once" >&2; exit 2; }
pids=(); names=()
for pair in "$@"; do
  setup="${pair%%:*}"; task="${pair##*:}"
  "$ROOT/scripts/run-setup.sh" "$setup" "$task" >"$ROOT/.roster/runs/$task.$setup.wave" 2>&1 &
  pids+=("$!"); names+=("$task.$setup")
  sleep 2   # stagger worktree creation
done
fail=0
for i in "${!pids[@]}"; do
  if wait "${pids[$i]}"; then :; else fail=1; fi
  echo "${names[$i]}: $(head -n 1 "$ROOT/.roster/runs/${names[$i]}.wave")"
done
exit "$fail"
