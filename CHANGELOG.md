# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-09-28

### Added
- **Voice conversations stay in voice (Claude Code plugin).** Once you've answered out loud, a plugin hook sends Claude back to reply by voice if it tries to answer in text. It does this at most once per spoken answer, so it can never loop. Voice mode ends when you type, when you don't answer, or when Claude says goodbye with `listen: false`. It's tracked per session and expires after 30 idle minutes. `VOICE_MCP_STAY_IN_VOICE=0` turns the hook off.
- **`speak_and_listen` with `listen: false`** speaks without opening the microphone, for one-way announcements or a goodbye. It needs only text-to-speech, not the recorder, whisper or a model.
- **One voice turn at a time across the whole Mac.** Claude Code windows, Claude Desktop and Cursor take turns at the speaker and mic, one turn at a time, so they never talk over each other. A waiting turn reports "waiting for another voice session" and gives up after `VOICE_MCP_LOCK_WAIT_SECONDS` (120) with a clear message. A lock left by a crashed session is taken over. If the cache folder isn't writable, turns go ahead without the lock.
- **README: an Upgrading section and a Voice mode section, plus a note on testing the plugin from a checkout.**

### Changed
- **Claude waits longer for you to start talking: 15 seconds, up from 8** (`VOICE_MCP_START_TIMEOUT_SECONDS`), so reading or thinking doesn't end the conversation.
- **When you don't answer, Claude asks once more, then pauses cleanly.** The "no speech" result now tells Claude that the mic is off, so it tells you to type to carry on rather than to speak.

### Removed
- The unused `packaging/` folder. `.github/` is the only copy of the workflows.

## [0.2.0] - 2026-09-28

### Added
- **A more natural voice, automatically.** On macOS, speech uses the best Premium or Enhanced voice installed for the spoken language, preferring your Mac's region, and otherwise the system voice. `voice_setup` shows which voice is in use and, if there's no Premium voice, how to download one for free in System Settings. `VOICE_MCP_VOICE=default` keeps the system voice.
- **A timing line on every turn.** Each `speak_and_listen` result ends with a line like `voice-mcp timing: spoke 3.1 s · listened 4.0 s (user talked 2.2 s) · transcribed 0.3 s`, which makes a slow turn easy to explain. The model is told to ignore it unless you ask.
- **Claude Code plugin commands and a skill:**
  - `/mac-voice-mcp:talk [task]` starts a voice conversation. It pre-approves voice turns while it runs.
  - `/mac-voice-mcp:setup` checks, installs with your OK, and tests.
  - The `voice-help` skill gives Claude fuller usage guidance and a troubleshooting table.
- **README: "Allow voice turns without prompts".** The `permissions.allow` entries that stop Claude Code from asking for approval on every voice turn.
- **Releases:**
  - `npm version patch|minor|major` now also updates `server.json` and the plugin.
  - Each tag creates a GitHub Release from this changelog.
  - Tests fail if any version, the plugin's pinned npm version or the changelog entry is out of sync.

### Changed
- **The plugin runs the exact npm release it ships with** (`mac-voice-mcp@0.2.0`), instead of whatever version npx cached first.
- **The README's install configs use `mac-voice-mcp@latest`,** so npx picks up new releases. This covers Claude Desktop, Cursor, VS Code and `claude mcp add`.
- **The publish workflow is safe to re-run.**
  - It skips npm and the MCP Registry when the version is already there.
  - It retries the registry while npm catches up.
  - It checks out without persisting credentials.

## [0.1.1] - 2026-09-23

### Added
- **README:** one-click install buttons for Cursor and VS Code, and install steps for the Claude Code plugin marketplace and the official MCP Registry.
- **Releases publish through npm trusted publishing, with provenance.**

### Changed
- **Node.js 22 or newer is now required.** Node 18 and 20 no longer receive security fixes. CI tests on Node 22, 24 and 26.

### Fixed
- **"It's on screen" when it isn't** ([#3](https://github.com/jeet0007/mac-voice-mcp/issues/3)).
  - When the spoken text sends you to look at something, the model is reminded that only its own message text reaches your screen, not the speech and not Bash/tool output. The speaking rules now say the same.
  - Thanks to Copilot for the first version ([#4](https://github.com/jeet0007/mac-voice-mcp/pull/4)).
  - The trigger phrases were narrowed so that ordinary sentences like "above thirty degrees" or "see the doctor" don't set it off.

### Security
- TruffleHog secret scanning, CodeQL, dependency review, `npm audit` in CI, and Dependabot.

## [0.1.0] - 2026-09-23

### Added
- First release:
  - `speak_and_listen`: natural turn-taking, with on-device whisper.cpp and a warm server.
  - `voice_setup`: checks first, installs only what's missing, and only after you agree.
  - The `setup` and `voice_mode` prompts.

[Unreleased]: https://github.com/jeet0007/mac-voice-mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/jeet0007/mac-voice-mcp/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/jeet0007/mac-voice-mcp/compare/119a589...v0.1.1
[0.1.0]: https://github.com/jeet0007/mac-voice-mcp/tree/119a589
