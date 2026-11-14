#!/bin/sh
# Play the call bubble's live-transcript panel with no mic and no call, and screenshot it.
# Usage: scripts/bubble-demo.sh [out-dir]   (default: a new temp folder, printed; stop early with Ctrl-C)
# Builds native/call-bubble.swift into a temp folder and runs it with a throwaway cache folder.
# Only the bubble's own area is captured (not the whole screen). macOS asks to allow screen recording
# for your terminal the first time; without it the shots come out empty or the script says so.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-$(mktemp -d "${TMPDIR:-/tmp}/bubble-demo-shots.XXXXXX")}
tmp=$(mktemp -d)
mkdir -p "$out"
swiftc -O "$root/native/call-bubble.swift" -o "$tmp/call-bubble"
VOICE_MCP_CACHE_DIR="$tmp/cache" "$tmp/call-bubble" --demo </dev/null &
pid=$!
trap 'kill $pid 2>/dev/null; rm -rf "$tmp"' EXIT INT TERM
echo "bubble demo running (pid $pid); screenshots go to $out"
# The demo pill starts near the top-right of the main display; capture just that corner region
# (the pill and the transcript panel above or below it), never the rest of the screen.
region=$(osascript -e 'tell application "Finder" to get bounds of window of desktop' 2>/dev/null | tr -d ' ' || true)
i=0
while [ $i -lt 14 ]; do
  sleep 2
  i=$((i + 1))
  if [ -n "$region" ]; then
    w=$(echo "$region" | cut -d, -f3)
    screencapture -x -R"$((w - 480)),0,480,300" "$out/shot-$(printf %02d $i).png" || echo "screencapture failed (allow screen recording for this terminal?)"
  else
    echo "couldn't find the screen size; no shot taken"; break
  fi
done
echo "shots: $out"
