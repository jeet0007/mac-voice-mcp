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
confirm_yes() { # same, but Enter means yes
  local answer
  read -r -p "  $1 [Y/n] " answer
  [ -z "$answer" ] || [[ "$answer" =~ ^[Yy] ]]
}
gh_ready() { command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; }

# GitHub's security features for the repo: secret scanning + push protection, Dependabot alerts
# and automatic security fixes, private vulnerability reporting. Skipped when already on.
enable_github_security() {
  gh_ready || return 0
  local status
  status="$(gh api "repos/$REPO" --jq '.security_and_analysis.secret_scanning_push_protection.status' 2>/dev/null || true)"
  if [ "$status" = "enabled" ]; then
    ok "GitHub security features already on"
    return 0
  fi
  confirm_yes "Turn on GitHub's security features (secret scanning + push protection, Dependabot alerts and fixes, private vulnerability reporting)?" || return 0
  printf '%s' '{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}' |
    gh api -X PATCH "repos/$REPO" --input - >/dev/null 2>&1 || info "Couldn't turn on secret scanning — enable it under Settings → Code security."
  gh api -X PUT "repos/$REPO/vulnerability-alerts" >/dev/null 2>&1 || true
  gh api -X PUT "repos/$REPO/automated-security-fixes" >/dev/null 2>&1 || true
  gh api -X PUT "repos/$REPO/private-vulnerability-reporting" >/dev/null 2>&1 || true
  ok "GitHub security features on"
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

# GitHub config is kept in packaging/ (Claude can't write into .github/ for you) and synced here.
# packaging/ is the source of truth: new or changed files are copied over.
sync_file() { # src dest
  if [ ! -e "$2" ] || ! cmp -s "$1" "$2"; then
    mkdir -p "$(dirname "$2")"
    cp "$1" "$2"
    return 0
  fi
  return 1
}
synced=0
for f in packaging/github-workflows/*.yml; do
  sync_file "$f" ".github/workflows/$(basename "$f")" && synced=$((synced + 1))
done
[ -f packaging/dependabot.yml ] && sync_file packaging/dependabot.yml .github/dependabot.yml && synced=$((synced + 1))
ok "GitHub config in place: CI, security scans, CodeQL, Dependabot, release workflow$([ "$synced" -gt 0 ] && echo " ($synced file(s) updated)")"

# --- 2. Tests ------------------------------------------------------------------------------
bold "2/6  Build and test"
[ -d node_modules ] || npm install --no-audit --no-fund --loglevel=error
if ! test_output="$(npm test 2>&1)"; then
  printf '%s\n' "$test_output" > test-output.log
  printf '%s\n' "$test_output" | grep -E "^not ok|^✖|^(#|ℹ) (pass|fail)" || printf '%s\n' "$test_output" | tail -15
  fail "Tests are failing — not publishing. Full output saved to test-output.log (Claude can read it there)."
fi
rm -f test-output.log
ok "All $(printf '%s\n' "$test_output" | sed -nE 's/^(#|ℹ) pass ([0-9]+).*/\2/p' | tail -1) tests pass"
if ! npm audit --omit=dev --audit-level=high >/dev/null 2>&1; then
  npm audit --omit=dev --audit-level=high || true
  fail "A dependency has a known high-severity vulnerability — not publishing. Try 'npm audit fix'."
fi
ok "No known vulnerabilities in dependencies"

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
# Some global gitignores exclude CLAUDE.md; this one is example documentation and belongs in the repo.
git add -f examples/CLAUDE.md 2>/dev/null || true
if ! git diff --cached --quiet; then
  git commit -q -m "mac-voice-mcp v$VERSION"
  ok "Committed"
fi

# Leaked-secret check over the whole history before anything goes public.
if ! command -v trufflehog >/dev/null 2>&1; then
  if confirm_yes "Install TruffleHog (Homebrew) to scan for leaked secrets before pushing?"; then
    HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ENV_HINTS=1 brew install trufflehog
  fi
fi
if command -v trufflehog >/dev/null 2>&1; then
  rc=0
  trufflehog git "file://$PWD" --results=verified,unknown --fail --no-update --json 2>/dev/null >trufflehog-findings.json || rc=$?
  if [ "$rc" -eq 0 ]; then
    rm -f trufflehog-findings.json
    ok "No leaked secrets in any commit (TruffleHog)"
  elif [ "$rc" -eq 183 ]; then # TruffleHog's "found something" exit code
    fail "TruffleHog found possible secrets — NOT pushing. See trufflehog-findings.json (and tell Claude)."
  else
    rm -f trufflehog-findings.json
    info "TruffleHog couldn't run (exit $rc) — skipping the local scan. CI will still scan every push."
  fi
else
  info "Skipped the local secret scan (TruffleHog not installed). CI will still scan every push."
fi

if git remote get-url origin >/dev/null 2>&1; then
  if git push -u origin HEAD; then
    ok "Pushed to github.com/$REPO"
  else
    info "Push failed — see the message above. Fix it, then run this script again (npm comes next either way)."
  fi
  if gh_ready; then
    gh repo edit "$REPO" --add-topic mcp-server --add-topic mcp --add-topic voice --add-topic whisper --add-topic macos >/dev/null 2>&1 || true
  fi
  enable_github_security
elif gh_ready; then
  if confirm "Create the PUBLIC repository github.com/$REPO and push?"; then
    if gh repo create "$REPO" --public --source . --push \
      --description "Talk with Claude out loud on your Mac — on-device speech with whisper.cpp. An MCP server." \
      --homepage "https://www.npmjs.com/package/$NAME"; then
      ok "Created and pushed github.com/$REPO"
    else
      info "The repo may have been created but the push failed — see above. Fix it, then run this script again."
    fi
    gh repo edit "$REPO" --add-topic mcp-server --add-topic mcp --add-topic voice --add-topic whisper --add-topic macos >/dev/null 2>&1 || true
    enable_github_security
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
    if ! npm publish --access public; then
      info "npm publish failed (see above). The usual cause is \"Two-factor authentication … is required\":"
      info "  npmjs.com → your avatar → Account → Two-Factor Authentication → enable it (an authenticator app or a"
      info "  security key), then run this script again. npm will ask for a one-time code when publishing."
      fail "Not published."
    fi
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

  One-time, so future releases need no npm token at all (npm "trusted publishing"):
    npmjs.com → $NAME → Settings → Trusted Publisher → GitHub Actions
      user: $GH_USER   repository: $NAME   workflow: publish.yml
    then under Publishing access choose "Require two-factor authentication and disallow tokens".
EOT
