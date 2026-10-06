<h1 align="center">🎙️ mac-voice-mcp</h1>

<p align="center">
  <b>Talk with Claude out loud on your Mac.</b><br>
  Natural turn-taking · on-device speech recognition · no audio leaves your computer
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/mac-voice-mcp"><img alt="npm version" src="https://img.shields.io/npm/v/mac-voice-mcp?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/mac-voice-mcp"><img alt="npm downloads" src="https://img.shields.io/npm/dm/mac-voice-mcp?color=cb3837"></a>
  <a href="https://github.com/jeet0007/mac-voice-mcp/actions/workflows/ci.yml"><img alt="Tests" src="https://github.com/jeet0007/mac-voice-mcp/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/jeet0007/mac-voice-mcp/actions/workflows/security.yml"><img alt="Security" src="https://github.com/jeet0007/mac-voice-mcp/actions/workflows/security.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/jeet0007/mac-voice-mcp/actions/workflows/codeql.yml"><img alt="CodeQL" src="https://github.com/jeet0007/mac-voice-mcp/actions/workflows/codeql.yml/badge.svg?branch=main"></a>
</p>

<p align="center">
  <img alt="Platform: macOS, Apple Silicon" src="https://img.shields.io/badge/platform-macOS%20%C2%B7%20Apple%20Silicon-000000?logo=apple">
  <a href="https://modelcontextprotocol.io"><img alt="MCP server" src="https://img.shields.io/badge/MCP-server-6f42c1"></a>
  <img alt="Node.js 22+" src="https://img.shields.io/node/v/mac-voice-mcp?logo=node.js&color=339933">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="SECURITY.md"><img alt="Dependabot enabled" src="https://img.shields.io/badge/Dependabot-enabled-025e8c?logo=dependabot"></a>
  <a href="#-vibe-coded"><img alt="Vibe-coded with Claude" src="https://img.shields.io/badge/vibe--coded-with%20Claude-d97757"></a>
</p>

---

Claude speaks through your Mac's speakers, listens to your answer the way a person would, and gets back what you said as text. Speech recognition runs on your Mac, so no audio leaves your computer.

```
Claude ──speak_and_listen("Tests pass. Open the PR?")──▶  🔊 "Tests pass. Open the PR?"
                                                         🎙 you: "yes, and tag Priya"
Claude ◀──────────────── "Yes, and tag Priya." ─────────  whisper.cpp on your Mac
```

**Perfect for:**

- Long tasks: Claude works quietly and checks in out loud when it needs a decision, so you can step away from the screen.
- Quick reviews: a 20-second summary of a pull request, then "approve it?"
- Resting your eyes, or your wrists, after a long day at the keyboard.
- Thinking out loud: talking a problem through instead of typing it.

## Features

- 🔒 **On-device.** whisper.cpp transcribes on your Mac. Recordings are deleted after each turn.
- 💬 **Natural turn-taking.** A soft chime, then it waits for you to start, and hands back about a second after you stop. No push-to-talk.
- ⚡ **Fast replies.** A warm whisper.cpp server keeps the model loaded, so transcribing takes a fraction of a second on Apple Silicon.
- 🗣️ **A natural voice, if you want one.** Uses your best macOS voice, or the optional [Kokoro](docs/voices.md#the-kokoro-voice-optional) neural voice.
- ✋ **Asks before installing anything.** Setup checks what you already have and reuses it.
- 🪟 **One mic, many windows.** Claude Code, Claude Desktop and Cursor take turns instead of talking over each other.
- 📏 **Measured, not guessed.** `doctor` checks the whole pipeline on your Mac and scores it PASS, WARN or FAIL.

## Quick start

You need a Mac (Apple Silicon recommended) and **Node.js 22 or newer**.

**1. Install.**

- **Claude Code** (recommended). Install the plugin:
  ```
  /plugin marketplace add jeet0007/mac-voice-mcp
  /plugin install mac-voice-mcp@mac-voice-mcp
  ```
- **Cursor or VS Code:** <a href="https://cursor.com/en/install-mcp?name=voice-mcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm1hYy12b2ljZS1tY3BAbGF0ZXN0Il19"><img alt="Add to Cursor" src="https://cursor.com/deeplink/mcp-install-dark.svg" height="24"></a> <a href="https://insiders.vscode.dev/redirect/mcp/install?name=voice-mcp&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22mac-voice-mcp%40latest%22%5D%7D"><img alt="Install in VS Code" src="https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white" height="24"></a>

- **Claude Desktop and other apps:** add `npx -y mac-voice-mcp@latest` as a stdio MCP server. See [Install](docs/install.md#by-hand) for each app.

**2. Set up.** Ask Claude to *"set up voice"* (or run `/mac-voice-mcp:setup`). It checks for SoX, whisper.cpp and a speech model, shows you what's missing, and installs it only after you say yes.

**3. Allow the microphone.** The first time Claude listens, macOS asks. Click **Allow**.

**4. Talk.** Run `/mac-voice-mcp:talk fix the flaky login test`, or ask Claude to *"check in with me by voice when you need a decision"*. Reply after the chime.

### Allow voice turns without prompts

Claude Code asks for approval every time Claude wants to speak, which breaks the flow of a conversation. To allow voice turns, add the tool to `permissions.allow` in `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_mac-voice-mcp_voice-mcp__speak_and_listen",
      "mcp__voice-mcp__speak_and_listen"
    ]
  }
}
```

The first name is for the plugin, the second for `claude mcp add voice-mcp …`. Leave `voice_setup` out, so installs still ask you first.

## How it works

The server has two tools and two prompts:

| | What it does |
|---|---|
| `speak_and_listen` | Speaks a short message, listens for one conversational turn and returns the transcript. |
| `voice_setup` | Checks what's installed. After you agree, it installs only what's missing. |
| `setup` prompt | A guided setup: it checks, asks you, installs, then runs a spoken test. |
| `voice_mode` prompt | A hands-free session where Claude checks in by voice at natural points. |

Claude is told how to write for the ear: short sentences, no markdown, file names instead of paths. If code or links still get through, the server rewrites them before speaking. In Claude Code, the plugin also keeps a voice conversation in voice until you type. More in [Using it](docs/usage.md).

## Troubleshooting

Run `npx -y mac-voice-mcp@latest doctor` first. It tests setup, the voice and transcription, and your speakers and mic, and tells you which part fails.

| Symptom | Fix |
|---|---|
| "microphone returned pure digital silence" | Allow the mic for the app (Claude, Cursor or your terminal) in **System Settings → Privacy & Security → Microphone**, then restart it. |
| It cuts me off while I'm thinking | Set `VOICE_MCP_END_SILENCE_MS=1800`. |
| The voice sounds robotic | Download a Premium macOS voice or install Kokoro. See [Voices](docs/voices.md). |
| It asks for approval every turn | See [Allow voice turns without prompts](#allow-voice-turns-without-prompts). |

More in [Troubleshooting](docs/troubleshooting.md).

## Documentation

- [Install](docs/install.md): every app, the MCP Registry, installing from a clone, upgrading.
- [Voices](docs/voices.md): macOS Premium voices and the optional Kokoro voice.
- [Using it](docs/usage.md): voice mode, several sessions, getting Claude to sound natural.
- [Configuration](docs/configuration.md): every setting, and the speech models.
- [Troubleshooting](docs/troubleshooting.md): common problems and known limitations.
- [Privacy and security](docs/privacy-security.md): what stays on your Mac, and how the project is secured.
- [Development](docs/development.md): building, testing and releasing.
- [Changelog](CHANGELOG.md)

### 🤖 Vibe-coded

> This project was designed and written with Claude, in conversation. A human (me) steered it, tested it on a real Mac and checked the test suite, but most of the code was written by AI. Read the [Disclaimer](#disclaimer) before you rely on it.

## Disclaimer

mac-voice-mcp is a free, open-source personal project. It's provided **as is, with no warranty of any kind**, and the authors aren't liable for any damage or loss from using it. See the [LICENSE](LICENSE) for the exact terms. In plain words:

- **It turns on your microphone** whenever an AI assistant calls `speak_and_listen`, and plays sound through your speakers.
- **Speech recognition makes mistakes.** An assistant may act on a misheard word. Check what it heard before you let it do anything you can't undo, like deleting files, pushing code or sending messages.
- **It installs software on your Mac**, but only after you agree: Homebrew packages, and kokoro-js with npm if you choose the Kokoro voice. Those are separate projects, under their own licenses (below).
- **There's no guaranteed support.** Issues and pull requests are welcome, and fixed on a best-effort basis.

**Trademarks.** Apple, Mac, macOS and Siri are trademarks of Apple Inc. Claude is a trademark of Anthropic. mac-voice-mcp is an independent project, not affiliated with, sponsored or endorsed by Apple or Anthropic.

### Third-party software

mac-voice-mcp doesn't bundle any of these. It uses them when they're on your Mac, and installs them only with your consent. Each one comes under its own license.

| Software | Used for | License |
|---|---|---|
| [SoX](https://sourceforge.net/projects/sox/) | Recording from the mic, Kokoro playback | GPL-2.0 |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | Speech-to-text | MIT |
| [Whisper models](https://huggingface.co/ggerganov/whisper.cpp) (OpenAI) | Speech-to-text | MIT |
| macOS voices (`say`) | The built-in voice | Apple's macOS license |
| [kokoro-js](https://github.com/hexgrad/kokoro) (optional) | The Kokoro voice | Apache-2.0 |
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) model (optional) | The Kokoro voice | Apache-2.0 |
| [espeak-ng](https://github.com/espeak-ng/espeak-ng) (optional, inside kokoro-js) | Turning text into sounds for Kokoro | GPL-3.0 |
| [ffmpeg](https://ffmpeg.org) (fallback, never installed by setup) | Recording, if SoX is missing | LGPL-2.1 / GPL |

## License

[MIT](LICENSE) © Jeet
