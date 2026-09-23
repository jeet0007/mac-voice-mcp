# Changelog

## 0.1.1

### Changed
- **Node.js 22 or newer is now required.** Node 18 and 20 no longer receive security fixes. CI tests on Node 22, 24 and 26.

### Fixed
- **"It's on screen" when it isn't** ([#3](https://github.com/jeet0007/mac-voice-mcp/issues/3)). When the spoken text sends you to look at something, the model gets a reminder that only its own message text reaches your screen, not the speech and not Bash/tool output. The speaking rules now say the same. Thanks to Copilot for the first version ([#4](https://github.com/jeet0007/mac-voice-mcp/pull/4)). The trigger phrases were then narrowed so that ordinary sentences like "above thirty degrees" or "see the doctor" don't set it off.

### Docs and tooling
- README: one-click install buttons for Cursor and VS Code, and install steps for the Claude Code plugin marketplace and the official MCP Registry.
- Security: TruffleHog secret scanning, CodeQL, dependency review, `npm audit` in CI, and Dependabot.
- Releases publish through npm trusted publishing, with provenance.

## 0.1.0

First release: `speak_and_listen` (natural turn-taking, on-device whisper.cpp with a warm server), `voice_setup` (check first, install only what's missing, only after you agree), and the `setup` and `voice_mode` prompts.
