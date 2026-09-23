#!/usr/bin/env bash
# Publish mac-voice-mcp: GitHub → npm → the official MCP Registry.
#
#   bash publish.sh
#
# Run it yourself, in your own Terminal: it uses YOUR GitHub and npm logins and
# asks before every public step. Safe to re-run — finished steps are skipped.
set -euo pipefail
cd "$(dirname "$0")"

NAME="mac-voice-mcp"
VERSION="$(node -p 'require("./package.json").version')"

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok() { printf '  ✔ %s\n' "$1"; }
info() { printf '  • %s\n' "$1"; }
fail() {
  printf '  ✘ %s\n' "$1" >&2
  exit 1
}
confirm() {
  local answer
  read -r -p "  $1 [y/N] " answer
  [[ "$answer" =~ ^[Yy] ]]
}
[ -t 0 ] || fail "Run this in an interactive Terminal — it asks before each public step."

# --- 1. Your GitHub username → fills in the placeholders ----------------------------------
bold "1/6  GitHub username"
if grep -rq "__GITHUB_USER__" package.json server.json README.md .claude-plugin 2>/dev/null; then
  GH_USER=""
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    GH_USER="$(gh api user --jq .login 2>/dev/null || true)"
  fi
  if [ -n "$GH_USER" ]; then
    confirm "Publish under the GitHub account \"$GH_USER\"?" || GH_USER=""
  fi
  while [ -z "$GH_USER" ]; do read -r -p "  Your GitHub username: " GH_USER; done
  grep -rl "__GITHUB_USER__" package.json server.json README.md .claude-plugin | while read -r f; do
    perl -pi -e "s/__GITHUB_USER__/${GH_USER}/g" "$f"
  done
  ok "Filled in $GH_USER"
else
  GH_USER="$(node -p 'require("./package.json").repository.url.match(/github\.com\/([^/]+)\//)[1]')"
  ok "Using $GH_USER"
fi
REPO="$GH_USER/$NAME"

# GitHub Actions workflows live in packaging/ until now (Claude can't write into .github/ for you).
if [ -d packaging/github-workflows ]; then
  mkdir -p .github/workflows
  for f in packaging/github-workflows/*.yml; do
    [ -e ".github/workflows/$(basename "$f")" ] || cp "$f" .github/workflows/
  done
  ok "GitHub Actions workflows in place (CI on every push; publishing on version tags)"
fi

# --- 2. Tests ------------------------------------------------------------------------------
bold "2/6  Build and test"
[ -d node_modules ] || npm install --no-audit --no-fund --loglevel=error
if ! test_output="$(npm test 2>&1)"; then
  printf '%s\n' "$test_output" > test-output.log
  printf '%s\n' "$test_output" | grep -E "^not ok|^# (pass|fail)" || printf '%s\n' "$test_output" | tail -15
  fail "Tests are failing — not publishing. Full output saved to test-output.log (Claude can read it there)."
fi
rm -f test-output.log
ok "All $(printf '%s\n' "$test_output" | sed -n 's/^# pass //p') tests pass"

# --- 3. GitHub -----------------------------------------------------------------------------
bold "3/6  GitHub (github.com/$REPO)"
if [ ! -d .git ]; then
  git init -q -b main
  ok "Created a git repository"
fi
if [ -z "$(git config user.name || true)" ] || [ -z "$(git config user.email || true)" ]; then
  fail "Git doesn't know who you are yet. Run: git config --global user.name \"Your Name\" && git config --global user.email you@example.com — then run this again."
fi
git add -A
if ! git diff --cached --quiet; then
  git commit -q -m "mac-voice-mcp v$VERSION"
  ok "Committed"
fi
if git remote get-url origin >/dev/null 2>&1; then
  git push -q -u origin HEAD 2>/dev/null && ok "Pushed to $(git remote get-url origin)" || info "Push skipped or failed — check 'git push' yourself"
elif command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  if confirm "Create the PUBLIC repository github.com/$REPO and push?"; then
    gh repo create "$REPO" --public --source . --push \
      --description "Talk with Claude out loud on your Mac — on-device speech with whisper.cpp. An MCP server." \
      --homepage "https://www.npmjs.com/package/$NAME"
    gh repo edit "$REPO" --add-topic mcp-server --add-topic mcp --add-topic voice --add-topic whisper --add-topic macos >/dev/null || true
    ok "Created and pushed github.com/$REPO"
  fi
else
  info "The GitHub CLI isn't set up, so create the repo in your browser:"
  info "  1. Go to https://github.com/new, name it '$NAME', make it Public, don't add a README."
  info "  2. Then run:  git remote add origin https://github.com/$REPO.git && git push -u origin main"
  info "  (Or: brew install gh && gh auth login — then run this script again.)"
fi

# --- 4. npm --------------------------------------------------------------------------------
bold "4/6  npm ($NAME@$VERSION)"
if npm view "$NAME@$VERSION" version >/dev/null 2>&1; then
  ok "Already on npm"
else
  if ! npm whoami >/dev/null 2>&1; then
    info "You're not logged in to npm. Opening npm login (create a free account at npmjs.com if you need one)…"
    npm login
  fi
  if confirm "Publish $NAME@$VERSION to npm publicly as $(npm whoami)?"; then
    npm publish --access public
    ok "Published — anyone can now run: npx -y $NAME"
  fi
fi

# --- 5. Official MCP Registry --------------------------------------------------------------
bold "5/6  Official MCP Registry (io.github.$GH_USER/$NAME)"
if curl -fsS "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.$GH_USER/$NAME" 2>/dev/null | grep -q "\"version\":\"$VERSION\""; then
  ok "Already listed"
elif ! npm view "$NAME@$VERSION" version >/dev/null 2>&1; then
  info "Skipped — publish to npm first (the registry checks the npm package)."
else
  if ! command -v mcp-publisher >/dev/null 2>&1; then
    confirm "Install the official mcp-publisher tool with Homebrew?" && HOMEBREW_NO_AUTO_UPDATE=1 brew install mcp-publisher
  fi
  if command -v mcp-publisher >/dev/null 2>&1 && confirm "List $NAME in the official MCP Registry?"; then
    info "A GitHub sign-in code will appear — open the link, enter it, then come back here."
    mcp-publisher login github
    mcp-publisher publish
    ok "Listed. Directories like Smithery, Glama, PulseMCP and mcp.so pick it up from here."
  fi
fi

# --- 6. What's next ------------------------------------------------------------------------
bold "6/6  Done — how people install it"
cat <<EOT
  Claude Code (plugin):   /plugin marketplace add $REPO
                          /plugin install $NAME@$NAME
  Claude Code (direct):   claude mcp add voice-mcp -s user -- npx -y $NAME
  Claude Desktop/Cursor:  see the README on github.com/$REPO

  Future releases: bump "version" in package.json and server.json, commit, then
    git tag v<version> && git push origin v<version>
  (add an NPM_TOKEN secret to the GitHub repo once, and GitHub Actions publishes everything).
EOT
