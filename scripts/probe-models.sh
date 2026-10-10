#!/usr/bin/env bash
# One cheap call per Claude Code setup: prints the model id the API actually resolved.
# Setups must record the resolved id (modelUsage), never just the requested flag.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
for cfg in "$ROOT"/setups/*.json; do
  [ "$(jq -r .harness "$cfg")" = "claude-code" ] || continue
  id="$(jq -r .id "$cfg")"; model="$(jq -r .model "$cfg")"
  out="$(cd "$ROOT" && env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_ENTRYPOINT \
        -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN \
        claude -p "Reply with the single word OK." --model "$model" --output-format json --max-turns 1 \
        --setting-sources project --strict-mcp-config --no-session-persistence 2>/dev/null || true)"
  resolved="$(printf '%s' "$out" | jq -r '(.modelUsage // {}) | keys | join(",")' 2>/dev/null || echo "?")"
  err="$(printf '%s' "$out" | jq -r 'select(.is_error) | .result' 2>/dev/null || true)"
  printf '%s requested=%s resolved=%s %s\n' "$id" "$model" "${resolved:-none}" "${err:+error: $err}"
done
if command -v codex >/dev/null; then echo "C codex: $(codex --version 2>&1 | head -1)"; else echo "C codex: not installed"; fi
