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

Claude says something through your Mac's speakers, listens to your answer the way a person would, and gets back what you said as text. Speech recognition runs on your Mac, so no audio leaves your computer.

```
Claude ──speak_and_listen("Tests pass. Open the PR?")──▶  🔊 "Tests pass. Open the PR?"
                                                         🎙 you: "yes, and tag Priya"
Claude ◀──────────────── "Yes, and tag Priya." ─────────  whisper.cpp on your Mac
```

It's built for Apple Silicon Macs (M1–M4). Linux works too, with SoX and espeak-ng installed.

### 🤖 Vibe-coded

> This project was designed and written with Claude, in conversation. A human (me) steered it, tried it on a real Mac and checked the test suite, but most of the code was written by AI. It's a **proof of concept**: it works and has tests, but expect rough edges, and read the code before relying on it for anything important. Issues and pull requests are welcome.
>
> It's an independent project, not made or endorsed by Anthropic. It works with any MCP client, including Claude Desktop, Claude Code and Cursor.

## How it works

The server has **two tools and two prompts**:

| | What it does |
|---|---|
| `speak_and_listen` | Speaks a short message, listens for one conversational turn and returns the transcript. |
| `voice_setup` | Checks what's installed. After you agree, it installs only what's missing. |
| `/mcp__voice-mcp__setup` | A guided setup: it checks, asks you, installs, then runs a spoken test. |
| `/mcp__voice-mcp__voice_mode` | A hands-free session where Claude checks in by voice at natural points. |

**Listening works like a conversation.** A soft chime plays when the mic opens. The server waits for you to start talking and hands back to Claude about a second after you stop. It adjusts to background noise, doesn't cut you off at pauses mid-sentence, and ignores coughs and clicks. If you say nothing for 8 seconds, Claude gets "no speech", which it is told never to treat as a yes.

**Replies come back fast.** whisper.cpp's server keeps the speech model loaded between turns, and the model starts loading while Claude is still talking. You don't wait for a model load on each reply. After 15 idle minutes the server shuts down to free memory. It is stopped automatically even if the MCP server crashes.

**Claude sends text meant to be heard.** The tool description gives Claude rules for writing short spoken sentences. If code, paths, links or markdown still get through, the server rewrites them before speaking and tells Claude, so the next message is cleaner. See [below](#getting-claude-to-sound-natural).

## Install

You need **Node.js 22 or newer**. Whichever way you install, run setup once afterwards (see *Then*, below).

### One click

<p>
  <a href="https://cursor.com/en/install-mcp?name=voice-mcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm1hYy12b2ljZS1tY3AiXX0%3D"><img alt="Add to Cursor" src="https://cursor.com/deeplink/mcp-install-dark.svg" height="32"></a>
  <a href="https://insiders.vscode.dev/redirect/mcp/install?name=voice-mcp&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22mac-voice-mcp%22%5D%7D"><img alt="Install in VS Code" src="https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white" height="32"></a>
  <a href="https://insiders.vscode.dev/redirect/mcp/install?name=voice-mcp&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22mac-voice-mcp%22%5D%7D&quality=insiders"><img alt="Install in VS Code Insiders" src="https://img.shields.io/badge/VS_Code_Insiders-Install_Server-24bfa5?style=for-the-badge&logo=visualstudiocode&logoColor=white" height="32"></a>
</p>

### From a marketplace

- **Claude Code plugin marketplace.** This repo is its own marketplace:
  ```
  /plugin marketplace add jeet0007/mac-voice-mcp
  /plugin install mac-voice-mcp@mac-voice-mcp
  ```
- **The official MCP Registry.** It's listed as [`io.github.jeet0007/mac-voice-mcp`](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.jeet0007/mac-voice-mcp). Apps and directories that read the registry pick it up from there. In VS Code, open the Extensions view (⇧⌘X), search `@mcp mac-voice`, and click **Install**. Smithery, Glama, PulseMCP and mcp.so copy the registry, so it shows up there too.

### By hand

**Claude Code**

```bash
claude mcp add voice-mcp -s user -- npx -y mac-voice-mcp
```

**Claude Desktop.** Add this to `~/Library/Application Support/Claude/claude_desktop_config.json`, then quit (⌘Q) and reopen the app:

```json
{
  "mcpServers": {
    "voice-mcp": {
      "command": "npx",
      "args": ["-y", "mac-voice-mcp"]
    }
  }
}
```

If you get `spawn npx ENOENT`, use the full path from `which npx`, e.g. `"command": "/opt/homebrew/bin/npx"`.

**Cursor.** Add the same `mcpServers` block to `~/.cursor/mcp.json`.

**VS Code.** Run **MCP: Add Server** from the Command Palette, or:

```bash
code --add-mcp '{"name":"voice-mcp","command":"npx","args":["-y","mac-voice-mcp"]}'
```

**Any other MCP client.** Run `npx -y mac-voice-mcp` as a stdio server.

### Then: set up and allow the mic

**Run setup once.** Ask Claude to *"set up voice"*. In Claude Code you can also run `/mcp__voice-mcp__setup`, or from a terminal run `npx -y mac-voice-mcp setup`.

Setup checks what's already there before it changes anything:

| Needed | Provided by | If it's missing |
|---|---|---|
| Voice | macOS `say` | Nothing to do. It's part of macOS. |
| Microphone capture | SoX (`rec`) | `brew install sox` |
| Speech-to-text | whisper.cpp (`whisper-cli` and `whisper-server`, Metal-accelerated) | `brew install whisper-cpp` |
| Speech model | `base.en`, ~140 MB | Downloaded once to `~/.cache/mac-voice-mcp/models/` |

- **Nothing is redone.** Tools already on your PATH are used as they are. If the model is already somewhere on disk (a whisper.cpp checkout, Homebrew's share folder, another tool's cache, or anything Spotlight can find), it's **symlinked**, not downloaded again. `brew install` runs only for the missing formulae.
- **Nothing happens without your OK.** Claude calls `voice_setup` to check first, shows you the checklist, and asks before calling it with `install=true`.
- **Slow installs don't time out.** If `brew install whisper-cpp` takes a while, setup reports INSTALLING. The install carries on in the background, and the next check picks up the result.

**Allow the microphone.** The first time Claude listens, macOS asks whether Claude (or Cursor, or your terminal) can use the microphone. Click Allow.

### Installing from a clone

One command does everything above: it builds the project, runs setup (asking before installing anything), adds voice-mcp to Claude Desktop (backing up your config first) and to Claude Code, and offers a spoken test. It's safe to re-run, because each step checks first and skips anything already done.

```bash
git clone https://github.com/jeet0007/mac-voice-mcp && bash mac-voice-mcp/install.sh
```

## Using it

- **"Work on X and check in with me by voice when you need a decision."** Claude works quietly and only speaks at decision points.
- **`/mcp__voice-mcp__voice_mode fix the flaky login test`.** Claude reads its plan back to you, then checks in at each checkpoint. Say "stop voice mode" or "I'm back" to end it.
- **"Read me a 20-second summary of this PR and ask if I should approve it."** Use this for one-off briefings.
- **Just talk after the chime.** You don't need to hurry or fill silence. If you're still talking at the 30-second safety cap (`listen_seconds`), Claude is told your reply may be cut off and asks you to continue.

## Getting Claude to sound natural

Guidance reaches Claude through several channels, because each client shows different ones:

| Channel | Who sees it |
|---|---|
| Tool description (rules plus a good and a bad example) | Every client |
| Server instructions (when to use voice, how to handle replies, setup) | Claude Code (it reads up to 2 KB) |
| The `voice_mode` and `setup` prompts | Claude Code (as slash commands), Claude Desktop, Cursor |
| Server-side rewrite plus a `voice-mcp note` back to Claude | Always on |

The rules Claude is given:

```
- 1–3 short sentences, under ~40 words; lead with the outcome, then one question.
- Plain words only: no markdown, bullets, emoji, code, file paths, URLs, stack traces or tables.
- Describe code instead of reading it, say file names not paths, round numbers, spell out symbols.
- Ask one question at a time, answerable in a few words.
- Put the details (diffs, logs, links) in the on-screen reply, and say so out loud.
```

The safety net turns `## Results\n- \`npm test\` ✅ 42/42\n- see /Users/x/repo/src/index.ts:120` into *"Results. npm test 42 of 42. see index.ts."*

Claude Desktop ignores server instructions. To make the rules stick there, paste [`examples/CLAUDE.md`](examples/CLAUDE.md) into *Settings → Profile → personal preferences* or into a Project's instructions. For Claude Code, add it to `CLAUDE.md`. For Cursor, copy [`examples/voice-mcp.mdc`](examples/voice-mcp.mdc) to `.cursor/rules/`.

## Configuration

Everything is optional. Set these in your client config's `"env": { … }` block, or with `-e NAME=value` in `claude mcp add`.

**Speaking**

| Variable | Default | |
|---|---|---|
| `VOICE_MCP_VOICE` | system voice | macOS voice, e.g. `Samantha`, `Daniel`, `Kanya`. List them with `say -v '?'`. |
| `VOICE_MCP_RATE` | system rate | Words per minute, e.g. `200`. |
| `VOICE_MCP_MAX_SPEAK_WORDS` | `120` | Longer text is cut at a sentence boundary ("the rest is on screen"). |
| `VOICE_MCP_CHIME` | `1` | Set to `0` to turn off the mic open/close sounds. |

**Listening**

| Variable | Default | |
|---|---|---|
| `VOICE_MCP_END_SILENCE_MS` | `1200` | How long a pause ends your turn. Use `1800` if it cuts you off while you think, `800` for snappier replies. |
| `VOICE_MCP_START_TIMEOUT_SECONDS` | `8` | How long to wait for you to start talking. |
| `VOICE_MCP_SPEECH_MARGIN_DB` | `12` | How much louder than room noise counts as speech. Raise it in noisy rooms. |
| `VOICE_MCP_MIN_SPEECH_DB` | `-48` | The quietest level that ever counts as speech (dBFS). |
| `VOICE_MCP_RECORDER` | `auto` | `sox` or `ffmpeg` (`ffmpeg` is macOS only). |

**Speech-to-text**

| Variable | Default | |
|---|---|---|
| `VOICE_MCP_WHISPER_MODEL` | `base.en` | Which model to use (see the table below). |
| `VOICE_MCP_LANGUAGE` | `en` for `*.en` models, otherwise `auto` | `en`, `th`, `ja`, `de`, … |
| `VOICE_MCP_WHISPER_PROMPT` | — | Words to bias toward: names, product terms, jargon. |
| `VOICE_MCP_WHISPER_MODEL_PATH` | — | Use this exact `ggml-*.bin` file. |
| `VOICE_MCP_MODEL_SEARCH_PATHS` | — | Extra folders to check for an existing model (`:`-separated). |
| `VOICE_MCP_WHISPER_SERVER` | `1` | Set to `0` to always use `whisper-cli`, with no warm server. |
| `VOICE_MCP_SERVER_IDLE_MINUTES` | `15` | How long the warm server stays up without use. |
| `VOICE_MCP_THREADS` | min(8, cores) | Number of whisper.cpp threads. |
| `VOICE_MCP_CACHE_DIR` | `~/.cache/mac-voice-mcp` | Where models are downloaded or symlinked. |
| `VOICE_MCP_DEBUG` | `0` | Verbose logs with per-turn timings, written to stderr. |

**Models** (whisper.cpp names):

| Model | Size | Good for |
|---|---|---|
| `tiny.en` | 75 MB | Yes/no answers, the lowest latency |
| `base.en` | 142 MB | **Default.** English conversation. |
| `small.en` | 466 MB | Noticeably more accurate English |
| `large-v3-turbo-q5_0` | 547 MB | Other languages, e.g. Thai with `VOICE_MCP_LANGUAGE=th` |

## Troubleshooting

| Symptom | Fix |
|---|---|
| "voice-mcp is not set up yet" | Ask Claude to *set up voice*, or run `npx -y mac-voice-mcp setup`. |
| "microphone returned pure digital silence" | macOS is blocking the mic for the host app. Go to **System Settings → Privacy & Security → Microphone**, enable Claude / Cursor / your terminal, then restart that app. |
| No permission prompt ever appears | Run `tccutil reset Microphone <bundle id>` and restart the app. Running `test` in Terminal only gives permission to Terminal, not to Claude Desktop. |
| It cuts me off while I'm thinking | Set `VOICE_MCP_END_SILENCE_MS=1800` (or up to `2500`). |
| It never stops listening | The room is too noisy for the defaults. Set `VOICE_MCP_SPEECH_MARGIN_DB=18`, or use a headset. |
| It hears its own voice | Use headphones, or turn the speaker volume down. It only listens after it finishes speaking, but echo can linger. |
| "Homebrew: not installed" | Install it from [brew.sh](https://brew.sh). It needs your password, so it can't run from Claude. Then run setup again. |
| It garbles names or jargon | Set `VOICE_MCP_WHISPER_PROMPT="Priya, Postgres, Kubernetes"`, or switch to `small.en`. |

## Known limitations

- **You can't interrupt it.** It finishes speaking, then listens. Barge-in would mean listening while the speakers play, which needs headphones or echo cancellation.
- **It's macOS-first.** Linux works with SoX and espeak-ng. Windows is untested.
- **Turn-taking is based on loudness, not a speech model.** It adapts to background noise, but very noisy rooms, music or TV can confuse it. A headset helps, and so do the listening settings above.
- **One conversation at a time.** There's one speaker and one microphone, so calls are queued.

## Privacy and safety

- **Audio stays on your machine.** Recordings go to a temporary file that's deleted after each turn. The only network use is the one-time model download from Hugging Face.
- **The warm whisper server is local only.** It listens on `127.0.0.1` on a random port, and stops when idle or when this server exits.
- **Setup can only install known packages.** Its install list is fixed in the code (`sox`, `whisper-cpp`), so nothing Claude says can make it install anything else. It never uninstalls or modifies other software.

## Security

- **Secrets:** every push and pull request is scanned for leaked secrets with [TruffleHog](https://github.com/trufflesecurity/trufflehog), and the whole history is scanned before the first push. GitHub secret scanning with push protection is also on.
- **Dependencies:** [Dependabot](https://docs.github.com/code-security/dependabot) opens weekly update pull requests. CI fails on high-severity advisories (`npm audit`), and dependency review blocks pull requests that add vulnerable packages.
- **Code:** [CodeQL](https://codeql.github.com) runs with the `security-extended` queries.
- **Releases:** releases publish through [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), with no long-lived npm token and a signed provenance attestation for every version.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Development

```bash
npm install
npm test               # build + 27 tests: unit tests and end-to-end tests over MCP with stub binaries
npm run audit          # known-vulnerability and signature checks on dependencies
npm run setup          # check what's installed; offers to install what's missing
npm run test:voice     # one real speak → listen → transcribe turn
npm run inspect        # MCP Inspector
```

| Module | Responsibility |
|---|---|
| `config.ts` | Environment settings, logging, the PATH fix-up for GUI apps |
| `speech-text.ts` | Rewriting screen text for speech, cleaning up transcripts (pure, unit-tested) |
| `endpointer.ts` | Turn-taking voice-activity detection (pure, unit-tested) |
| `audio.ts` | Text-to-speech, chimes, streaming mic capture |
| `model.ts` | Finding, symlinking or downloading the model |
| `stt.ts` | The warm `whisper-server` with orphan guard, and the `whisper-cli` fallback |
| `setup.ts` | Requirement checks and consent-based background installs |
| `voice.ts`, `server.ts`, `index.ts` | The round trip, the MCP tools and prompts, and the CLI |

The package installs two commands: `mac-voice-mcp` (the one `npx -y mac-voice-mcp` runs), and `voice-mcp`.

### Releasing

- **First release:** `bash publish.sh`. It asks before each public step and uses your own GitHub and npm logins. It creates the GitHub repo, publishes to npm, and lists the server in the [official MCP Registry](https://registry.modelcontextprotocol.io), which Smithery, Glama, PulseMCP and mcp.so pick up from.
- **Later releases:** bump `version` in `package.json` and `server.json`, then push a `v<version>` tag. The Publish workflow tests the build, checks that the tag matches both versions, and publishes to npm and the MCP Registry. It needs no secrets: both logins use GitHub's OIDC identity, once you've set the package's *Trusted Publisher* on npmjs.com (`publish.sh` prints the steps).

## License

MIT
