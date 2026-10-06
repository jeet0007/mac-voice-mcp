# Install

[← README](../README.md) · [Install](install.md) · [Voices](voices.md) · [Using it](usage.md) · [Configuration](configuration.md) · [Troubleshooting](troubleshooting.md) · [Privacy & security](privacy-security.md) · [Development](development.md)

You need **Node.js 22 or newer** and a Mac (Apple Silicon recommended). Whichever way you install, run [setup](#set-up-and-allow-the-mic) once afterwards.

## One click

<p>
  <a href="https://cursor.com/en/install-mcp?name=voice-mcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm1hYy12b2ljZS1tY3BAbGF0ZXN0Il19"><img alt="Add to Cursor" src="https://cursor.com/deeplink/mcp-install-dark.svg" height="32"></a>
  <a href="https://insiders.vscode.dev/redirect/mcp/install?name=voice-mcp&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22mac-voice-mcp%40latest%22%5D%7D"><img alt="Install in VS Code" src="https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white" height="32"></a>
  <a href="https://insiders.vscode.dev/redirect/mcp/install?name=voice-mcp&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22mac-voice-mcp%40latest%22%5D%7D&quality=insiders"><img alt="Install in VS Code Insiders" src="https://img.shields.io/badge/VS_Code_Insiders-Install_Server-24bfa5?style=for-the-badge&logo=visualstudiocode&logoColor=white" height="32"></a>
</p>

## From a marketplace

- **Claude Code plugin marketplace.** This repo is its own marketplace:
  ```
  /plugin marketplace add jeet0007/mac-voice-mcp
  /plugin install mac-voice-mcp@mac-voice-mcp
  ```
  The plugin adds `/mac-voice-mcp:setup` and `/mac-voice-mcp:talk`, a skill that teaches Claude how to use voice well and fix common problems, and a hook that keeps a voice conversation in voice (see [Voice mode](usage.md#voice-mode)). Each plugin version runs the matching npm release.
- **The official MCP Registry.** It's listed as [`io.github.jeet0007/mac-voice-mcp`](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.jeet0007/mac-voice-mcp). Apps and directories that read the registry pick it up from there. In VS Code, open the Extensions view (⇧⌘X), search `@mcp mac-voice`, and click **Install**. Smithery, Glama, PulseMCP and mcp.so copy the registry, so it shows up there too.

## By hand

**Claude Code**

```bash
claude mcp add voice-mcp -s user -- npx -y mac-voice-mcp@latest
```

**Claude Desktop.** Add this to `~/Library/Application Support/Claude/claude_desktop_config.json`, then quit (⌘Q) and reopen the app:

```json
{
  "mcpServers": {
    "voice-mcp": {
      "command": "npx",
      "args": ["-y", "mac-voice-mcp@latest"]
    }
  }
}
```

`@latest` makes npx check for a new release each time the app starts. Without it, npx keeps running whichever version it cached first.

If you get `spawn npx ENOENT`, use the full path from `which npx`, e.g. `"command": "/opt/homebrew/bin/npx"`.

**Cursor.** Add the same `mcpServers` block to `~/.cursor/mcp.json`.

**VS Code.** Run **MCP: Add Server** from the Command Palette, or:

```bash
code --add-mcp '{"name":"voice-mcp","command":"npx","args":["-y","mac-voice-mcp@latest"]}'
```

**Any other MCP client.** Run `npx -y mac-voice-mcp@latest` as a stdio server.

## Set up and allow the mic

**Run setup once.** Ask Claude to *"set up voice"*. In Claude Code you can also run `/mac-voice-mcp:setup` (plugin) or `/mcp__voice-mcp__setup` (added by hand), or from a terminal run `npx -y mac-voice-mcp@latest setup`.

Setup checks what's already there before it changes anything:

| Needed | Provided by | If it's missing |
|---|---|---|
| Voice | macOS `say`, using the most natural voice installed | Nothing to do. For a far better voice, add a free Premium one, or the Kokoro voice (see [Voices](voices.md)). |
| Microphone capture | SoX (`rec`). ffmpeg works as a fallback, but setup recommends SoX | `brew install sox` |
| Speech-to-text | whisper.cpp (`whisper-cli` and `whisper-server`, Metal-accelerated) | `brew install whisper-cpp` |
| Speech model | `base.en`, ~140 MB | Downloaded once to `~/.cache/mac-voice-mcp/models/` |

- **Nothing is redone.** Tools already on your PATH are used as they are. If the model is already somewhere on disk (a whisper.cpp checkout, Homebrew's share folder, another tool's cache, or anything Spotlight can find), it's **symlinked**, not downloaded again. `brew install` runs only for the missing formulae.
- **Nothing happens without your OK.** Claude calls `voice_setup` to check first, shows you the checklist, and asks before calling it with `install=true`.
- **Slow installs don't time out.** If `brew install whisper-cpp` takes a while, setup reports INSTALLING. The install carries on in the background, and the next check picks up the result.

**Allow the microphone.** The first time Claude listens, macOS asks whether Claude (or Cursor, or your terminal) can use the microphone. Click Allow.

For a more natural voice, see [Voices](voices.md).

## Allow voice turns without prompts

By default, Claude Code asks for approval every time Claude wants to speak, which breaks the flow of a conversation. To allow voice turns, add the tool to the `permissions.allow` list in `~/.claude/settings.json`. Use the name that matches how you installed it:

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

The first name is for the plugin, the second for `claude mcp add voice-mcp …`. Leave `voice_setup` out, so installs still ask you first. While `/mac-voice-mcp:talk` runs, voice turns are already allowed.

## Installing from a clone

One command does everything on this page: it builds the project, runs setup (asking before installing anything), adds voice-mcp to Claude Desktop (backing up your config first) and to Claude Code, and offers a spoken test. It's safe to re-run, because each step checks first and skips anything already done.

```bash
git clone https://github.com/jeet0007/mac-voice-mcp && bash mac-voice-mcp/install.sh
```

## Upgrading

- **Claude Code plugin:** run `/plugin marketplace update mac-voice-mcp`, then open `/plugin`, choose mac-voice-mcp under your installed plugins, and update it. Restart Claude Code. If there's no update option, uninstall and reinstall it.
- **Everything installed with `mac-voice-mcp@latest`** (Claude Desktop, Cursor, VS Code, `claude mcp add`): restart the app. npx fetches the new release when the server starts.
- **Configs without `@latest`:** change `mac-voice-mcp` to `mac-voice-mcp@latest` in the config, then restart the app. Otherwise npx keeps running the version it cached first.

Check which version you'd get with `npx -y mac-voice-mcp@latest --version`, and see what changed in the [changelog](../CHANGELOG.md). Your model, voice and settings carry over.
