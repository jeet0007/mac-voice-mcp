#!/bin/sh
# Play the call bubble's live-transcript panel with no mic and no call, and screenshot it.
# Usage: scripts/bubble-demo.sh [out-dir]   (default ./bubble-demo-shots; stop early with Ctrl-C)
# Builds native/call-bubble.swift into a temp folder and runs it with a throwaway cache folder.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-./bubble-demo-shots}
tmp=$(mktemp -d)
mkdir -p "$out"
swiftc -O "$root/native/call-bubble.swift" -o "$tmp/call-bubble"
VOICE_MCP_CACHE_DIR="$tmp/cache" "$tmp/call-bubble" --demo </dev/null &
pid=$!
trap 'kill $pid 2>/dev/null; rm -rf "$tmp"' EXIT INT TERM
echo "bubble demo running (pid $pid); screenshots go to $out"
i=0
while [ $i -lt 14 ]; do
  sleep 2
  i=$((i + 1))
  screencapture -x "$out/shot-$(printf %02d $i).png" || echo "screencapture failed (allow screen recording for this terminal?)"
done
