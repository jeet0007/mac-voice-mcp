# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Docs and the voice-help skill now suggest `small.en` for noisy rooms,** with measured numbers: on real recordings with background noise it got 8% of words wrong instead of 12% with `base.en`, the same in a quiet room, at about 0.3 s per reply. `base.en` stays the default, so nobody gets a 466 MB download they didn't ask for.

### Fixed
- **`doctor` explains a voice that produces no audio.** Sometimes macOS `say` finishes without error but writes almost no sound (0.1 s for a whole sentence), for example when a voice's speech data is missing. `doctor` used to report that as "0% of words right". Now it tries once more, then says which voice wrote no audio and how to pick another (`VOICE_MCP_VOICE`). This was also behind the speech round trip failing on some CI runs, which now use a fixed classic voice.
- **A cough or a fan no longer counts as your answer.** For a sound with no words, whisper writes a note like `[gunshot]` (a cough), `[APPLAUSE]` (typing) or `[sound of running]` (a fan), and those notes were passed to Claude as if you'd said them. Now every sound note is dropped, and Claude is told it heard a sound but no words. On 10 noise-only clips (cough, typing, fan, hum, music, a door, breathing, silence), all 10 now come back as no speech.
- **Sentences whisper invents from videos are dropped**, such as "You can find the link in the description below." or "Thanks for watching!". Only whole sentences that nobody says to a coding assistant; "Thank you." and "Bye." stay.

## [0.4.1] - 2026-10-10

### Added
- **README: a Disclaimer, a Third-party software table and a trademark note.** They spell out what the tool does on your Mac (mic, installs with your consent), that speech recognition can mishear, the license of everything it uses but doesn't bundle, and that the project isn't affiliated with Apple or Anthropic.

### Changed
- **whisper hears developer talk better.** In English it now gets a one-sentence hint that the conversation is a developer talking to a coding assistant. On 60 test clips read by three voices, word errors fell from 3.4% to 2.3% on everyday sentences and from 3.8% to 3.1% on developer jargon ("rebase", "backend"), and nothing was invented in silence. `VOICE_MCP_WHISPER_PROMPT` replaces the hint with your own, and `none` turns it off.
- **A shorter README, in the style of popular MCP servers:** what it's for, features, a four-step quick start and the most common fixes. The full guides moved to [`docs/`](docs/): install, voices, usage, configuration, troubleshooting, privacy and security, and development.

### Fixed
- **The first words of a reply were often lost.** The "mic open" chime played before the recorder had actually started, and opening a mic takes a moment (longer with Bluetooth), so anyone who answered right at the chime lost a word or two. In a test with 20 real recordings, 12 began mid-word, and the cut-off starts led whisper to mishear or invent the rest ("Open a draft PR…" came back as "You can find the link in the description below."). Now the mic opens first and the chime plays once audio is flowing; the chime's own sound is ignored. Re-recorded with the fix, 2 of 20 began mid-word, and whisper's word errors on that voice fell from about 20% to 5% (and from 28% to 12% with background noise).

### Security
- **MCP SDK 1.32.1** ([GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h)). The advisory is in the SDK's OAuth client, which this server never uses (it only talks over stdio), but `npm audit` flagged every install.

## [0.4.0] - 2026-10-06

### Added
- **An optional natural voice: Kokoro.** [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) is a small neural voice that runs on your Mac and sounds much closer to a person than `say`.
  - **Install it only if you want it:** `voice_setup` with `kokoro=true` (Claude asks first), or `npx mac-voice-mcp setup --kokoro`. It installs `kokoro-js@1.2.1` with npm into `~/.cache/mac-voice-mcp/kokoro/` and downloads the model once, about 1 GB on disk. Nothing is bundled, and speaking never downloads anything.
  - **Once installed it's used automatically**, with the `af_heart` voice. It runs in its own warm process and speaks sentence by sentence, so the first sentence plays while the rest is generated. The timing line shows how soon the first sound came.
  - **It can't leave you without a voice.** If Kokoro fails, the built-in voice says whatever hadn't been said yet, and Claude is told once.
  - **Settings:** `VOICE_MCP_TTS` (`auto`, `say` or `kokoro`), `VOICE_MCP_KOKORO_VOICE`, `VOICE_MCP_KOKORO_SPEED`, `VOICE_MCP_KOKORO_DTYPE` and `VOICE_MCP_KOKORO_DIR`.
  - **`doctor` and the CI round trip cover Kokoro too:** whisper must understand it, and the first sound must come quickly.
- **`doctor`: an objective self-check** (`npx mac-voice-mcp doctor`). It checks the whole pipeline on your Mac and marks each stage PASS, WARN or FAIL against fixed limits:
  - **Setup:** everything is installed.
  - **Speech → text:** the voice speaks a known sentence into a file, and whisper must get the words right.
  - **Speaker → mic:** the same sentence is played aloud and recorded. It catches mic permission problems, the wrong input device and headphones.

  Reports are saved as JSON under `~/.cache/mac-voice-mcp/doctor/`. Use `--no-loopback` to skip the speakers, and `--json` for machine-readable output.
- **A "Speech round trip" CI job on a real Mac.** It installs everything with our own `setup --install`, runs `doctor`, then speaks known sentences (everyday and developer jargon) with the real voice and transcribes them with the real whisper.cpp. The build fails on too many wrong words or slow transcription.
- **`npm run dev:plugin`** loads this checkout into Claude Code as a separate "mac-voice-mcp-dev" plugin. It runs the local build with `node`, with no npx and no clash with the installed plugin.

## [0.3.1] - 2026-09-29

### Fixed
- **Recording broke on Macs without SoX when Bluetooth headphones were connected** ([#6](https://github.com/jeet0007/mac-voice-mcp/issues/6)). Every turn failed with "pure digital silence".
  - The ffmpeg fallback now records from the input chosen in System Settings (`:default`) instead of device number 0. `VOICE_MCP_FFMPEG_DEVICE` still overrides it.
  - `voice_setup` treats ffmpeg as a fallback, recommends SoX, and installs it with your OK.
  - Silence recorded through ffmpeg now points at the input device and SoX, not only at mic permissions.
- **`voice_setup` notices tools installed since the last check**, such as `brew install sox` run in a terminal, without restarting the app.

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

[Unreleased]: https://github.com/jeet0007/mac-voice-mcp/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/jeet0007/mac-voice-mcp/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/jeet0007/mac-voice-mcp/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/jeet0007/mac-voice-mcp/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jeet0007/mac-voice-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jeet0007/mac-voice-mcp/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/jeet0007/mac-voice-mcp/compare/119a589...v0.1.1
[0.1.0]: https://github.com/jeet0007/mac-voice-mcp/tree/119a589
