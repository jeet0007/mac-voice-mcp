#!/bin/sh
# Runs after every tool call (Claude Code plugin hook). Starting Node each time would cost ~40 ms,
# so first check, in the shell, whether the user said anything while Claude worked: almost always
# the inbox is empty and this exits at once. Only then does voice-mode.mjs hand it over.
cache="${VOICE_MCP_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/mac-voice-mcp}"
for f in "$cache/voice-mode/inbox/"*.json; do
  [ -e "$f" ] && exec node "$(dirname "$0")/voice-mode.mjs"
  break
done
exit 0
