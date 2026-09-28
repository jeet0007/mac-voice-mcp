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

**Listening works like a conversation.** A soft chime plays when the mic opens. The server waits for you to start talking and hands back to Claude about a second after you stop. It adjusts to background noise, doesn't cut you off at pauses mid-sentence, and ignores coughs and clicks. If you say nothing for 15 seconds, Claude gets "no speech", which it is told never to treat as a yes.

**Replies come back fast.** whisper.cpp's server keeps the speech model loaded between turns, and the model starts loading while Claude is still talking. You don't wait for a model load on each reply. After 15 idle minutes the server shuts down to free memory. It is stopped automatically even if the MCP server crashes.

**Claude sends text meant to be heard.** The tool description gives Claude rules for writing short spoken sentences. If code, paths, links or markdown still get through, the server rewrites them before speaking and tells Claude, so the next message is cleaner. See [below](#getting-claude-to-sound-natural).

## Install

You need **Node.js 22 or newer**. Whichever way you install, run setup once afterwards (see *Then*, below).

### One click

<p>
  <a href="https://cursor.com/en/install-mcp?name=voice-mcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm1hYy12b2ljZS1tY3BAbGF0ZXN0Il19"><img alt="Add to Cursor" src="https://cursor.com/deeplink/mcp-install-dark.svg" height="32"></a>
  <a href="https://insiders.vscode.dev/redirect/mcp/install?name=voice-mcp&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22mac-voice-mcp%40latest%22%5D%7D"><img alt="Install in VS Code" src="https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white" height="32"></a>
  <a href="https://insiders.vscode.dev/redirect/mcp/install?name=voice-mcp&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22mac-voice-mcp%40latest%22%5D%7D&quality=insiders"><img alt="Install in VS Code Insiders" src="https://img.shields.io/badge/VS_Code_Insiders-Install_Server-24bfa5?style=for-the-badge&logo=visualstudiocode&logoColor=white" height="32"></a>
</p>

### From a marketplace

- **Claude Code plugin marketplace.** This repo is its own marketplace:
  ```
  /plugin marketplace add jeet0007/mac-voice-mcp
  /plugin install mac-voice-mcp@mac-voice-mcp
  ```
  The plugin adds `/mac-voice-mcp:setup` and `/mac-voice-mcp:talk`, a skill that teaches Claude how to use voice well and fix common problems, and a hook that keeps a voice conversation in voice (see [Voice mode](#voice-mode)). Each plugin version runs the matching npm release.
- **The official MCP Registry.** It's listed as [`io.github.jeet0007/mac-voice-mcp`](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.jeet0007/mac-voice-mcp). Apps and directories that read the registry pick it up from there. In VS Code, open the Extensions view (⇧⌘X), search `@mcp mac-voice`, and click **Install**. Smithery, Glama, PulseMCP and mcp.so copy the registry, so it shows up there too.

### By hand

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

### Then: set up and allow the mic

**Run setup once.** Ask Claude to *"set up voice"*. In Claude Code you can also run `/mac-voice-mcp:setup` (plugin) or `/mcp__voice-mcp__setup` (added by hand), or from a terminal run `npx -y mac-voice-mcp@latest setup`.

Setup checks what's already there before it changes anything:

| Needed | Provided by | If it's missing |
|---|---|---|
| Voice | macOS `say`, using the most natural voice installed | Nothing to do. For a far better voice, add a free Premium one (see below). |
| Microphone capture | SoX (`rec`) | `brew install sox` |
| Speech-to-text | whisper.cpp (`whisper-cli` and `whisper-server`, Metal-accelerated) | `brew install whisper-cpp` |
| Speech model | `base.en`, ~140 MB | Downloaded once to `~/.cache/mac-voice-mcp/models/` |

- **Nothing is redone.** Tools already on your PATH are used as they are. If the model is already somewhere on disk (a whisper.cpp checkout, Homebrew's share folder, another tool's cache, or anything Spotlight can find), it's **symlinked**, not downloaded again. `brew install` runs only for the missing formulae.
- **Nothing happens without your OK.** Claude calls `voice_setup` to check first, shows you the checklist, and asks before calling it with `install=true`.
- **Slow installs don't time out.** If `brew install whisper-cpp` takes a while, setup reports INSTALLING. The install carries on in the background, and the next check picks up the result.

**Allow the microphone.** The first time Claude listens, macOS asks whether Claude (or Cursor, or your terminal) can use the microphone. Click Allow.

**Get a better voice (recommended).** macOS includes free Premium voices that sound far more natural than the default. Open **System Settings → Accessibility → Spoken Content → System Voice → Manage Voices…**, and download one, for example English → *Ava (Premium)* or *Zoe (Premium)*. The next voice turn uses it automatically. To choose a specific voice, or keep the system voice, see `VOICE_MCP_VOICE` under [Configuration](#configuration).

### Allow voice turns without prompts

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

### Installing from a clone

One command does everything above: it builds the project, runs setup (asking before installing anything), adds voice-mcp to Claude Desktop (backing up your config first) and to Claude Code, and offers a spoken test. It's safe to re-run, because each step checks first and skips anything already done.

```bash
git clone https://github.com/jeet0007/mac-voice-mcp && bash mac-voice-mcp/install.sh
```

## Upgrading

- **Claude Code plugin:** run `/plugin marketplace update mac-voice-mcp`, then open `/plugin`, choose mac-voice-mcp under your installed plugins, and update it. Restart Claude Code. If there's no update option, uninstall and reinstall it.
- **Everything installed with `mac-voice-mcp@latest`** (Claude Desktop, Cursor, VS Code, `claude mcp add`): restart the app. npx fetches the new release when the server starts.
- **Configs without `@latest`:** change `mac-voice-mcp` to `mac-voice-mcp@latest` in the config, then restart the app. Otherwise npx keeps running the version it cached first.

Check which version you'd get with `npx -y mac-voice-mcp@latest --version`, and see what changed in the [changelog](CHANGELOG.md). Your model, voice and settings carry over.

## Using it

- **"Work on X and check in with me by voice when you need a decision."** Claude works quietly and only speaks at decision points.
- **`/mac-voice-mcp:talk fix the flaky login test`** (plugin), or **`/mcp__voice-mcp__voice_mode fix the flaky login test`** (added by hand). Claude reads its plan back to you, then checks in at each checkpoint. Say "stop voice mode" or "I'm back" to end it.
- **"Read me a 20-second summary of this PR and ask if I should approve it."** Use this for one-off briefings.
- **Just talk after the chime.** You don't need to hurry or fill silence. If you're still talking at the 30-second safety cap (`listen_seconds`), Claude is told your reply may be cut off and asks you to continue.

### Voice mode

Once you answer out loud, you're in a voice conversation. Claude replies by voice, not in text, until one of these happens:

- **You type something.** You're back at the keyboard.
- **You say you're done.** Claude says a short goodbye without opening the mic (`speak_and_listen` with `listen: false`).
- **You don't answer.** After 15 seconds of silence Claude asks once more. If you still don't answer, it pauses and summarizes on screen, and the mic stays off. Type anything, or run `/mac-voice-mcp:talk`, to pick up again.

In Claude Code, the plugin enforces this with a hook. If Claude tries to answer in text mid-conversation, the hook sends it back once to answer by voice. If it stops again, the hook lets it. To turn the hook off, add `"VOICE_MCP_STAY_IN_VOICE": "0"` to the `env` block in `~/.claude/settings.json`. Other apps rely on the instructions alone.

**Several sessions, one mic.** Every mac-voice-mcp on your Mac takes turns: Claude Code windows, Claude Desktop and Cursor. While one is speaking or listening, the others wait for that turn to finish (shown as "waiting for another voice session"). They give up after 2 minutes with a message. If a session crashes, the next one takes the mic over.

## Getting Claude to sound natural

Guidance reaches Claude through several channels, because each client shows different ones:

| Channel | Who sees it |
|---|---|
| Tool description (rules plus a good and a bad example) | Every client |
| Server instructions (when to use voice, how to handle replies, setup) | Claude Code (it reads up to 2 KB) |
| The `voice_mode` and `setup` prompts | Claude Code (as slash commands), Claude Desktop, Cursor |
| Server-side rewrite plus a `voice-mcp note` back to Claude | Always on |
| The plugin's `/mac-voice-mcp:talk`, `voice-help` skill and stay-in-voice hook | Claude Code, with the plugin |

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
| `VOICE_MCP_VOICE` | most natural installed | Unset: the best Premium or Enhanced voice installed for the language, else the system voice. Set a name, e.g. `Ava (Premium)`, `Daniel`, `Kanya` (list them with `say -v '?'`), or `default` to always use the system voice. |
| `VOICE_MCP_RATE` | system rate | Words per minute, e.g. `200`. |
| `VOICE_MCP_MAX_SPEAK_WORDS` | `120` | Longer text is cut at a sentence boundary ("the rest is on screen"). |
| `VOICE_MCP_CHIME` | `1` | Set to `0` to turn off the mic open/close sounds. |
| `VOICE_MCP_LOCK_WAIT_SECONDS` | `120` | How long a turn waits while another session on this Mac is using the mic. |

**Listening**

| Variable | Default | |
|---|---|---|
| `VOICE_MCP_END_SILENCE_MS` | `1200` | How long a pause ends your turn. Use `1800` if it cuts you off while you think, `800` for snappier replies. |
| `VOICE_MCP_START_TIMEOUT_SECONDS` | `15` | How long to wait for you to start talking. |
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

**Claude Code plugin hook.** Set this in the `env` block of `~/.claude/settings.json`, not in the server's config:

| Variable | Default | |
|---|---|---|
| `VOICE_MCP_STAY_IN_VOICE` | `1` | Set to `0` to stop the plugin's hook from sending Claude back to answer by voice. |

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
| "voice-mcp is not set up yet" | Ask Claude to *set up voice*, or run `npx -y mac-voice-mcp@latest setup`. |
| "microphone returned pure digital silence" | macOS is blocking the mic for the host app. Go to **System Settings → Privacy & Security → Microphone**, enable Claude / Cursor / your terminal, then restart that app. |
| No permission prompt ever appears | Run `tccutil reset Microphone <bundle id>` and restart the app. Running `test` in Terminal only gives permission to Terminal, not to Claude Desktop. |
| It cuts me off while I'm thinking | Set `VOICE_MCP_END_SILENCE_MS=1800` (or up to `2500`). |
| It never stops listening | The room is too noisy for the defaults. Set `VOICE_MCP_SPEECH_MARGIN_DB=18`, or use a headset. |
| It hears its own voice | Use headphones, or turn the speaker volume down. It only listens after it finishes speaking, but echo can linger. |
| "Homebrew: not installed" | Install it from [brew.sh](https://brew.sh). It needs your password, so it can't run from Claude. Then run setup again. |
| It garbles names or jargon | Set `VOICE_MCP_WHISPER_PROMPT="Priya, Postgres, Kubernetes"`, or switch to `small.en`. |
| The voice sounds robotic | Download a Premium voice (see [Get a better voice](#then-set-up-and-allow-the-mic)). It's used automatically. |
| It asks for approval every turn | Add the tool to Claude Code's allow list: see [Allow voice turns without prompts](#allow-voice-turns-without-prompts). |
| "Another voice session on this Mac…" | Another Claude window, Claude Desktop or Cursor held the speaker and mic for over 2 minutes, which means one very long turn. End that conversation, then try again. |
| Claude keeps answering by voice after I'm done | Type anything, or say "stop voice mode". To switch the plugin's hook off entirely, see [Voice mode](#voice-mode). |
| Turns feel slow | Each result ends with a timing line, e.g. `spoke 3.1 s · listened 4.0 s · transcribed 0.3 s`. Ask Claude what it says. Transcribing should take well under a second. |

## Known limitations

- **You can't interrupt it.** It finishes speaking, then listens. Barge-in would mean listening while the speakers play, which needs headphones or echo cancellation.
- **It's macOS-first.** Linux works with SoX and espeak-ng. Windows is untested.
- **Turn-taking is based on loudness, not a speech model.** It adapts to background noise, but very noisy rooms, music or TV can confuse it. A headset helps, and so do the listening settings above.
- **One conversation at a time.** There's one speaker and one microphone, so turns from every session on the Mac are queued.

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
npm test               # build + unit tests, end-to-end tests over MCP with stub binaries, and release-metadata checks
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
| `lock.ts` | One voice turn at a time across every session on the Mac |
| `voice.ts`, `server.ts`, `index.ts` | The round trip, the MCP tools and prompts, and the CLI |
| `skills/`, `hooks/` | The Claude Code plugin's `/mac-voice-mcp:talk` and `:setup` commands, the `voice-help` skill, and the stay-in-voice hook |

The package installs two commands: `mac-voice-mcp` (the one `npx -y mac-voice-mcp` runs), and `voice-mcp`.

**Testing the plugin: don't start Claude Code inside this repo.** In this folder, `npx mac-voice-mcp@<this version>` finds the checkout itself instead of downloading the package, can't run it, and the server fails with `CONNECTION_CLOSED`. Start `claude` in any other folder. To try unreleased plugin files (skills, hooks), swap the marketplace to your checkout: run `/plugin marketplace remove mac-voice-mcp`, then `/plugin marketplace add /path/to/checkout`, and install at user scope. The server still comes from npm, so test server changes with `npm test` and `npm run test:voice`.

### Releasing

- **First release:** `bash publish.sh`. It asks before each public step and uses your own GitHub and npm logins. It creates the GitHub repo, publishes to npm, and lists the server in the [official MCP Registry](https://registry.modelcontextprotocol.io), which Smithery, Glama, PulseMCP and mcp.so pick up from.
- **Later releases:**
  1. Add a section to `CHANGELOG.md` for the new version, in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format, dated today.
  2. Run `npm version patch` (bug fixes), `npm version minor` (new features) or `npm version major` (breaking changes), per [semver](https://semver.org). It updates `package.json`, `package-lock.json`, `server.json` and the plugin (including the npm version the plugin runs), commits, and tags `v<version>`.
  3. Run `git push --follow-tags`.

  The Publish workflow then runs the tests, which also check that every version and the changelog entry match. It publishes to npm with provenance, lists the release in the MCP Registry, and creates a GitHub Release from the changelog section. It needs no secrets: npm and the registry both use GitHub's OIDC identity, once you've set the package's *Trusted Publisher* on npmjs.com (`publish.sh` prints the steps). If a step fails, fix the cause and use **Re-run failed jobs**. Steps that already finished are skipped.

## License

MIT
