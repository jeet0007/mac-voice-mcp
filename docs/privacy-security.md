# Privacy and security

[← README](../README.md) · [Install](install.md) · [Voices](voices.md) · [Using it](usage.md) · [Configuration](configuration.md) · [Troubleshooting](troubleshooting.md) · [Privacy & security](privacy-security.md) · [Development](development.md)

## Privacy and safety

- **Audio stays on your machine.** Recordings go to a temporary file that's deleted after each turn. The only network use is the one-time model download from Hugging Face, plus npm and Hugging Face once more if you install the Kokoro voice. Speaking never downloads anything.
- **Between turns, only "Claude, …" is kept.** With the plugin in Claude Code, the mic stays open while Claude works (the orange dot shows it). What it hears is transcribed on your Mac and dropped unless it starts with Claude's name; that sentence is left in a local file only your account can read, for the plugin to hand to Claude, then deleted. A video or call that says "Claude, …" is passed on too, so the talk skill has Claude confirm anything destructive by voice first. `VOICE_MCP_LISTEN_WHILE_WORKING=0` turns this off.
- **The warm whisper server is local only.** It listens on `127.0.0.1` on a random port, and stops when idle or when this server exits.
- **Setup can only install known packages.** Its install list is fixed in the code (`sox`, `whisper-cpp`, and `kokoro-js@1.2.1` for the optional voice), so nothing Claude says can make it install anything else. It never uninstalls or modifies other software.
- **Licenses of the optional Kokoro voice.** The Kokoro model and kokoro-js are Apache-2.0. kokoro-js turns text into sounds with a WebAssembly build of espeak-ng (GPL-3.0), through the `phonemizer` package. None of this is part of mac-voice-mcp (MIT). It's installed on your Mac only if you ask for it.

- **The flight recorder is off unless you turn it on.** With `VOICE_MCP_FLIGHT_RECORDER=on` (or `audio`), voice-mcp keeps a log of what the voice pipeline decided, so a bad turn can be explained later. It holds timings, audio levels, and reasons (why a turn ended, whether a reply finished) and only the *lengths* of transcripts and spoken text, never the words. It lives in `~/.cache/mac-voice-mcp/flight/` (or `VOICE_MCP_CACHE_DIR`), readable only by your account (folder `0700`, files `0600`), is deleted after 7 days (`VOICE_MCP_FLIGHT_DAYS`, 1 to 30), and each day's file stops growing at 10 MB. Nothing is uploaded: the recorder has no network code, and a test checks that. `mac-voice-mcp flight status` shows what is kept; `mac-voice-mcp flight purge` deletes all of it.
- **Flags and the audio option.** A flag (the `flag` tool, or `mac-voice-mcp flag "note"`) copies the last minute of events, your optional note, and your voice settings into `flight/flags/flag-<time>.md`, which stays on the Mac until you share it. Only in `audio` mode does the server also hold the last few seconds of microphone audio *in memory* (`VOICE_MCP_FLIGHT_AUDIO_SECONDS`, 5 to 60, default 30); it reaches the disk, as `flag-<time>.wav`, only when you flag a moment, and it's lost when the server stops. A flag you copy into an issue or chat is yours to share; check it first.
## Security

- **Secrets:** every push and pull request is scanned for leaked secrets with [TruffleHog](https://github.com/trufflesecurity/trufflehog), and the whole history is scanned before the first push. GitHub secret scanning with push protection is also on.
- **Dependencies:** [Dependabot](https://docs.github.com/code-security/dependabot) opens weekly update pull requests. CI fails on high-severity advisories (`npm audit`), and dependency review blocks pull requests that add vulnerable packages.
- **Code:** [CodeQL](https://codeql.github.com) runs with the `security-extended` queries.
- **Releases:** releases publish through [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), with no long-lived npm token and a signed provenance attestation for every version.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).
