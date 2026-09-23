#!/usr/bin/env bash
# One-step installer for mac-voice-mcp on macOS.
#
#   bash install.sh
#
# Safe to re-run: every step checks first and only does what's missing.
#   1. Homebrew + Node.js 18+          (installs Node with brew only if missing)
#   2. Build this project              (skipped when already up to date)
#   3. SoX, whisper.cpp, speech model  (via `setup`: reuses anything already present, asks before installing)
#   4. Register with Claude Desktop    (merges into your config, with a backup; other servers untouched)
#      and Claude Code, if installed
#   5. Optional spoken test
set -euo pipefail

cd "$(dirname "$0")"
DIR="$(pwd)"
ENTRY="$DIR/dist/index.js"

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok() { printf '  ✔ %s\n' "$1"; }
info() { printf '  • %s\n' "$1"; }
fail() {
  printf '  ✘ %s\n' "$1" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || fail "This installer is for macOS."

# --- 1. Homebrew and Node.js ---------------------------------------------------------------
bold "1/5  Homebrew and Node.js"
if ! command -v brew >/dev/null 2>&1; then
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$b" ]; then
      eval "$("$b" shellenv)"
      break
    fi
  done
fi
command -v brew >/dev/null 2>&1 || fail "Homebrew isn't installed. Install it from https://brew.sh (it asks for your password), then run this again."
ok "Homebrew found ($(command -v brew))"

node_ok() {
  command -v node >/dev/null 2>&1 && [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 18 ]
}
if node_ok; then
  ok "Node.js $(node -v) already installed"
else
  info "Node.js 18+ not found — installing it with Homebrew…"
  HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ENV_HINTS=1 brew install node
  hash -r
  node_ok || fail "Node.js still isn't available after installing. Open a new Terminal window and run this again."
  ok "Node.js $(node -v) installed"
fi
NODE="$(command -v node)"

# --- 2. Build ------------------------------------------------------------------------------
bold "2/5  Build voice-mcp"
if [ -d node_modules ] && [ -f "$ENTRY" ] && [ -z "$(find src package.json -newer "$ENTRY" 2>/dev/null | head -1)" ]; then
  ok "Already built and up to date"
else
  npm install --no-audit --no-fund --loglevel=error
  ok "Built"
fi

# --- 3. Speech tools -----------------------------------------------------------------------
bold "3/5  Speech tools (only what's missing)"
if [ -t 0 ]; then
  # Shows what's already installed and asks before installing anything.
  "$NODE" "$ENTRY" setup
else
  "$NODE" "$ENTRY" setup --install
fi

# --- 4. Register with Claude ---------------------------------------------------------------
bold "4/5  Add voice-mcp to Claude"
DESKTOP_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
"$NODE" - "$DESKTOP_CONFIG" "$NODE" "$ENTRY" <<'JS'
const fs = require("fs");
const path = require("path");
const [configPath, node, entry] = process.argv.slice(2);

let config = {};
let raw = "";
if (fs.existsSync(configPath)) {
  raw = fs.readFileSync(configPath, "utf8");
  try {
    config = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    console.error(`  ✘ ${configPath} isn't valid JSON, so I won't touch it. Add voice-mcp by hand (see README).`);
    process.exit(0);
  }
}

config.mcpServers = config.mcpServers || {};
const existing = config.mcpServers["voice-mcp"];
if (existing && existing.command === node && JSON.stringify(existing.args) === JSON.stringify([entry])) {
  console.log("  ✔ Claude Desktop: already set up");
  process.exit(0);
}
// Keep any settings (e.g. "env") you added to an existing entry.
config.mcpServers["voice-mcp"] = { ...(existing || {}), command: node, args: [entry] };

fs.mkdirSync(path.dirname(configPath), { recursive: true });
if (raw) {
  const backup = `${configPath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.writeFileSync(backup, raw);
  console.log(`  • Backed up your existing config to ${path.basename(backup)}`);
}
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
console.log(`  ✔ Claude Desktop: added voice-mcp${existing ? " (updated the existing entry)" : ""}`);
JS

if command -v claude >/dev/null 2>&1; then
  if claude mcp get voice-mcp >/dev/null 2>&1; then
    ok "Claude Code: already set up"
  elif claude mcp add voice-mcp -s user -- "$NODE" "$ENTRY" >/dev/null 2>&1; then
    ok "Claude Code: added voice-mcp"
  else
    info "Claude Code: couldn't add automatically — run: claude mcp add voice-mcp -s user -- \"$NODE\" \"$ENTRY\""
  fi
else
  info "Claude Code not found — skipped"
fi

# --- 5. Optional test ----------------------------------------------------------------------
bold "5/5  Quick test"
if [ -t 0 ]; then
  read -r -p "  Hear it work now? Your Mac will speak, then listen after a chime. [Y/n] " answer
  if [ -z "$answer" ] || [[ "$answer" =~ ^[Yy] ]]; then
    info "Terminal may ask for microphone access — click Allow."
    "$NODE" "$ENTRY" test "Hi! Voice is set up. Say something after the chime and I'll write down what I heard." || true
  fi
else
  info "Skipped (not an interactive terminal)"
fi

bold "Done."
echo "  Quit Claude Desktop completely (⌘Q) and reopen it, then ask Claude to say something out loud."
echo "  The first time, macOS asks whether Claude can use the microphone — click Allow."
