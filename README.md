<h1 align="center">🎙️ mac-voice-mcp</h1>

<p align="center">
  <b>Talk with Claude out loud on your Mac.</b><br>
  Natural turn-taking, on-device speech recognition, and no audio leaves your computer.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/mac-voice-mcp"><img alt="npm version" src="https://img.shields.io/npm/v/mac-voice-mcp?logo=npm&color=cb3837"></a>
  <a href="https://github.com/jeet0007/mac-voice-mcp/actions/workflows/ci.yml"><img alt="Tests" src="https://github.com/jeet0007/mac-voice-mcp/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <img alt="Platform: macOS" src="https://img.shields.io/badge/platform-macOS-000000?logo=apple">
  <a href="https://modelcontextprotocol.io"><img alt="MCP server" src="https://img.shields.io/badge/MCP-server-6f42c1"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

mac-voice-mcp is an MCP server that gives Claude a voice. Claude speaks through your Mac's speakers, listens for your answer the way a person would, and gets back what you said as text. Speech recognition runs on your Mac with whisper.cpp.

```
Claude ──speak_and_listen("Tests pass. Open the PR?")──▶  🔊 "Tests pass. Open the PR?"
                                                         🎙 you: "yes, and tag Priya"
Claude ◀──────────────── "Yes, and tag Priya." ─────────  whisper.cpp on your Mac
```

Use it to step away from the screen during long tasks, hear a quick summary of a pull request, rest your eyes, or think a problem through out loud.

## Highlights

- 🔒 **On-device.** whisper.cpp transcribes on your Mac, and recordings are deleted after each turn.
- 💬 **Natural turn-taking.** No push-to-talk. A soft tick opens the mic, and it hands back about 1.5 seconds after you stop.
- 📞 **Calls.** Keep the mic open until you hang up, and talk over Claude to interrupt it, even on the Mac's own speakers. An optional floating bubble shows the call and the words it hears.
- ⚡ **Fast.** A warm whisper.cpp server keeps the model loaded, so a reply is transcribed in a fraction of a second on Apple Silicon.
- 🗣️ **A natural voice.** Uses your best macOS voice, or the optional Kokoro neural voice.
- ✋ **Asks before installing.** Setup reuses what you have and installs the rest only after you agree.
- 🩺 **Measured.** `doctor` checks the whole pipeline on your Mac and scores each part PASS, WARN or FAIL.

## Installation

You need a Mac (Apple Silicon recommended) and Node.js 22 or newer.

**Claude Code** (recommended):

```
/plugin marketplace add jeet0007/mac-voice-mcp
/plugin install mac-voice-mcp@mac-voice-mcp
/plugin install voice-buddy@mac-voice-mcp
```

Voice Buddy is optional. It shows a one-line voice status above the prompt, and lets you interrupt by typing.

**Cursor or VS Code:**
<a href="https://cursor.com/en/install-mcp?name=voice-mcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm1hYy12b2ljZS1tY3BAbGF0ZXN0Il19"><img alt="Add to Cursor" src="https://cursor.com/deeplink/mcp-install-dark.svg" height="24"></a>
<a href="https://insiders.vscode.dev/redirect/mcp/install?name=voice-mcp&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22mac-voice-mcp%40latest%22%5D%7D"><img alt="Install in VS Code" src="https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white" height="24"></a>

**Claude Desktop and other apps:** add `npx -y mac-voice-mcp@latest` as a stdio MCP server. See [Install](docs/install.md#by-hand) for each app.

Then ask Claude to *"set up voice"*, or run `/mac-voice-mcp:setup`. It checks for SoX, whisper.cpp and a speech model, and installs what's missing after you say yes. The first time Claude listens, macOS asks for the microphone. Click **Allow**.

## Usage

Start a voice turn with a task:

```
/mac-voice-mcp:talk fix the flaky login test
```

Or ask Claude to *"check in with me by voice when you need a decision"*, and reply after the tick.

For a hands-free conversation, start a call. Talk whenever you like, and say "hang up" to end it.

```
/mac-voice-mcp:call
```

To stop Claude Code asking for approval before every voice turn, add the tool to `permissions.allow` in `~/.claude/settings.json`:

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

The first name is for the plugin, and the second is for `claude mcp add voice-mcp`. Leave `voice_setup` out, so installs still ask you first. See [Using it](docs/usage.md) for voice mode, calls, Voice Buddy and several sessions.

## Troubleshooting

Run `npx -y mac-voice-mcp@latest doctor` first. It tests setup, the voice, transcription, your speakers and your mic, and tells you which part fails.

| Symptom | Fix |
|---|---|
| "microphone returned pure digital silence" | Allow the mic for your app in **System Settings → Privacy & Security → Microphone**, then restart the app. |
| It cuts me off while I'm thinking | Set `VOICE_MCP_END_SILENCE_MS=2000`. |
| The voice sounds robotic | Download a Premium macOS voice or install Kokoro. See [Voices](docs/voices.md). |

See [Troubleshooting](docs/troubleshooting.md) for more.

## Documentation

- [Install](docs/install.md): every app, the MCP Registry, installing from a clone, and upgrading.
- [Using it](docs/usage.md): voice mode, calls, talking while Claude works, and Voice Buddy.
- [Voices](docs/voices.md): macOS Premium voices and the optional Kokoro voice.
- [Configuration](docs/configuration.md): every setting, and the speech models.
- [Privacy and security](docs/privacy-security.md): what stays on your Mac, and how the project is secured.
- [Development](docs/development.md): building, testing and releasing.
- [Changelog](CHANGELOG.md)

## Contributing

Issues and pull requests are welcome. See [Development](docs/development.md) to build and test, and [SECURITY.md](SECURITY.md) to report a vulnerability privately.

## License

[MIT](LICENSE) © Jeet. This project was written mostly by AI, with a human steering and testing it. It turns on your microphone and can install software after you agree. Read the [disclaimer and third-party licenses](NOTICE.md) before you rely on it.
