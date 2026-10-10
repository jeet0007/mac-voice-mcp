# Troubleshooting

[← README](../README.md) · [Install](install.md) · [Voices](voices.md) · [Using it](usage.md) · [Configuration](configuration.md) · [Troubleshooting](troubleshooting.md) · [Privacy & security](privacy-security.md) · [Development](development.md)

| Symptom | Fix |
|---|---|
| Not sure what's wrong | Run `npx -y mac-voice-mcp@latest doctor`. It checks setup, the voice and transcription, and your speakers and mic, and says which part fails. |
| "voice-mcp is not set up yet" | Ask Claude to *set up voice*, or run `npx -y mac-voice-mcp@latest setup`. |
| "microphone returned pure digital silence" | macOS is blocking the mic for the host app. Go to **System Settings → Privacy & Security → Microphone**, enable Claude / Cursor / your terminal, then restart that app. If the message says it's recording with ffmpeg, the input device is the likelier cause: run `brew install sox`. |
| No permission prompt ever appears | Run `tccutil reset Microphone <bundle id>` and restart the app. Running `test` in Terminal only gives permission to Terminal, not to Claude Desktop. |
| It misses my first word | Wait for the chime: it plays once the mic is really recording. If words are still lost, run `doctor` and check the input device. |
| It cuts me off while I'm thinking | Set `VOICE_MCP_END_SILENCE_MS=1800` (or up to `2500`). |
| It never stops listening | The room is too noisy for the defaults. Set `VOICE_MCP_SPEECH_MARGIN_DB=18`, or use a headset. |
| It hears its own voice | Use headphones, or turn the speaker volume down. It only listens after it finishes speaking, but echo can linger. |
| "Homebrew: not installed" | Install it from [brew.sh](https://brew.sh). It needs your password, so it can't run from Claude. Then run setup again. |
| It garbles names or jargon | Describe the conversation in `VOICE_MCP_WHISPER_PROMPT` as a sentence that uses the words, e.g. `"A call with Priya about the Postgres and Kubernetes migration."`, or switch to `small.en`. |
| The voice sounds robotic | Download a Premium voice, or install the Kokoro voice (see [Voices](voices.md)). Either is used automatically. |
| "The Kokoro voice didn't work" | The built-in voice spoke instead. Ask Claude to *check voice setup*, or run `npx -y mac-voice-mcp@latest setup`. To reinstall it, delete `~/.cache/mac-voice-mcp/kokoro/` and run `setup --kokoro`. |
| It asks for approval every turn | Add the tool to Claude Code's allow list: see [Allow voice turns without prompts](install.md#allow-voice-turns-without-prompts). |
| "Another voice session on this Mac…" | Another Claude window, Claude Desktop or Cursor held the speaker and mic for over 2 minutes, which means one very long turn. End that conversation, then try again. |
| Claude keeps answering by voice after I'm done | Type anything, or say "stop voice mode". To switch the plugin's hook off entirely, see [Voice mode](usage.md#voice-mode). |
| Turns feel slow | Each result ends with a timing line, e.g. `spoke 3.1 s · listened 4.0 s · transcribed 0.3 s`. Ask Claude what it says. Transcribing should take well under a second. |

## Known limitations

- **You can't interrupt it.** It finishes speaking, then listens. Barge-in would mean listening while the speakers play, which needs headphones or echo cancellation.
- **It's macOS-first.** Linux works with SoX and espeak-ng. Windows is untested.
- **Turn-taking is based on loudness, not a speech model.** It adapts to background noise, but very noisy rooms, music or TV can confuse it. A headset helps, and so do the [listening settings](configuration.md#listening).
- **One conversation at a time.** There's one speaker and one microphone, so turns from every session on the Mac are queued.
