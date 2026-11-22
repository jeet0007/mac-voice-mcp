# Configuration

[← README](../README.md) · [Install](install.md) · [Voices](voices.md) · [Using it](usage.md) · [Configuration](configuration.md) · [Troubleshooting](troubleshooting.md) · [Privacy & security](privacy-security.md) · [Development](development.md)

Everything is optional. Set these in your client config's `"env": { … }` block, or with `-e NAME=value` in `claude mcp add`.

## Speaking

| Variable | Default | |
|---|---|---|
| `VOICE_MCP_VOICE` | system voice | Unset (or `default`): the voice chosen in System Settings → Accessibility → Spoken Content → System Voice. `best`: the most natural Premium or Enhanced voice installed for the language. Or a name, e.g. `Ava (Premium)`, `Daniel`, `Kanya` (list them with `say -v '?'`). |
| `VOICE_MCP_RATE` | system rate | Words per minute, e.g. `200` (macOS voices). |
| `VOICE_MCP_TTS` | `auto` | `auto`: the [Kokoro voice](voices.md#the-kokoro-voice-optional) once it's installed, else the built-in voice. `say`: always the built-in voice. `kokoro`: Kokoro, and setup offers to install it. |
| `VOICE_MCP_KOKORO_VOICE` | `af_heart` | Kokoro voice. American English starts with `a`, British with `b`, e.g. `af_bella`, `am_michael`, `bf_emma`, `bm_george`. |
| `VOICE_MCP_KOKORO_SPEED` | `1` | Kokoro speaking speed, `0.5` to `2`. |
| `VOICE_MCP_KOKORO_DTYPE` | `fp32` | `q8`: a smaller model (~90 MB instead of ~330 MB) that's about half as fast. |
| `VOICE_MCP_KOKORO_STALL_SECONDS` | `30` | If the Kokoro voice makes no sound for this long, voice-mcp resets it and the built-in voice finishes the reply. |
| `VOICE_MCP_KOKORO_DIR` | `~/.cache/mac-voice-mcp/kokoro` | Where the Kokoro voice is installed. |
| `VOICE_MCP_MAX_SPEAK_WORDS` | `120` | Longer text is cut at a sentence boundary ("the rest is on screen"), and Claude is told how much was spoken. |
| `VOICE_MCP_VOICE_STANDBY` | `1` | The built-in voice is started ahead of each reply and waits for the text, so the reply starts sooner (about 0.8 s sooner with Siri voices). It's started after your first voice turn and stopped after 15 idle minutes. `0` starts it only when there's something to say. |
| `VOICE_MCP_CHIME` | `1` | Set to `0` to turn off all the sounds: mic open (tick), closed after words (pop), closed after nothing was heard (purr) and errors (thud). Spoken errors still play. |
| `VOICE_MCP_SPOKEN_ERRORS` | `1` | When a voice turn can't work (no microphone access, no recorder, no speech model), voice-mcp says one short fixed line out loud with the built-in voice, after the error sound. Each kind is spoken at most once per 10 minutes per server. `0` turns the lines off; the sounds still play (see `VOICE_MCP_CHIME`). A microphone busy in another window is never spoken. |
| `VOICE_MCP_PHASE_FILE` | `1` | Writes what a voice turn is doing (`speaking`, `listening`, `transcribing`, `waiting`) to `voice-mode/phase.json` in the cache folder, for Voice Buddy's status line, the call bubble, or a display of your own. One file for the whole Mac; removed when the turn ends. `0` turns it off. |
| `VOICE_MCP_LISTEN_WHILE_WORKING` | `1` | Claude Code plugin: after you answer out loud, listen while Claude works for things you say to it ("Claude, …"). See [Talk to Claude while it works](usage.md#talk-to-claude-while-it-works). `0` turns it off. |
| `VOICE_MCP_WORK_LISTEN_MINUTES` | `10` | Stop listening while Claude works after this long without a voice turn. |
| `VOICE_MCP_LOCK_WAIT_SECONDS` | `120` | How long a turn waits while another session on this Mac is using the mic. |

## Listening

| Variable | Default | |
|---|---|---|
| `VOICE_MCP_END_SILENCE_MS` | `1500` | How long a pause ends your turn. Use `2000` if it still cuts you off while you think, `1000` for snappier replies. |
| `VOICE_MCP_START_TIMEOUT_SECONDS` | `15` | How long to wait for you to start talking. |
| `VOICE_MCP_SPEECH_MARGIN_DB` | `12` | How much louder than room noise counts as speech. Raise it in noisy rooms. |
| `VOICE_MCP_MIN_SPEECH_DB` | `-48` | The quietest level that ever counts as speech (dBFS). |
| `VOICE_MCP_RECORDER` | `auto` | `sox` or `ffmpeg` (`ffmpeg` is macOS only). `auto` uses SoX, falling back to ffmpeg. |
| `VOICE_MCP_FFMPEG_DEVICE` | `:default` | Which input ffmpeg records from. `:default` follows System Settings; `:1` picks device 1 (list them with `ffmpeg -f avfoundation -list_devices true -i ""`). |

## Speech-to-text

| Variable | Default | |
|---|---|---|
| `VOICE_MCP_WHISPER_MODEL` | `base.en` | Which model to use (see the table below). |
| `VOICE_MCP_LANGUAGE` | `en` for `*.en` models, otherwise `auto` | `en`, `th`, `ja`, `de`, … |
| `VOICE_MCP_WHISPER_PROMPT` | a developer word list (English) | Tells whisper which words to expect, so it hears them better. By default, in English: `npm, JSON, TypeScript, git, main, rebase, pull request, CI, macOS.` Write your own list of names and terms, e.g. `Priya, Postgres, Kubernetes, migration.`, or set `none` for no hint. With the silence filter on, on 60 jargon clips, this list got 11.3% of words wrong, a sentence about a developer 13.2%, and no hint 14.5%. A sentence also turned foreign background talk into a sentence about code. |
| `VOICE_MCP_WHISPER_MODEL_PATH` | — | Use this exact `ggml-*.bin` file. |
| `VOICE_MCP_MODEL_SEARCH_PATHS` | — | Extra folders to check for an existing model (`:`-separated). |
| `VOICE_MCP_WHISPER_SERVER` | `1` | Set to `0` to always use `whisper-cli`, with no warm server. |
| `VOICE_MCP_SERVER_IDLE_MINUTES` | `15` | How long the warm server stays up without use. |
| `VOICE_MCP_THREADS` | min(8, cores) | Number of whisper.cpp threads. |
| `VOICE_MCP_MODEL_BASE_URL` | Hugging Face | A mirror that serves the `ggml-*.bin` models, and the silence filter `ggml-silero-v5.1.2.bin`. |
| `VOICE_MCP_CACHE_DIR` | `~/.cache/mac-voice-mcp` | Where models are downloaded or symlinked. |
| `VOICE_MCP_DEBUG` | `0` | Verbose logs with per-turn timings, written to stderr. |

## Flight recorder
Off by default. An opt-in, on-device log for "why was that turn cut off?": numbers and reasons only, never transcripts or spoken text. See [Privacy and security](privacy-security.md).
| Variable | Default | |
|---|---|---|
| `VOICE_MCP_FLIGHT_RECORDER` | `off` | `on`: log events to `~/.cache/mac-voice-mcp/flight/`. `audio`: also keep the last seconds of mic audio in memory, written as a WAV only when you flag a moment. |
| `VOICE_MCP_FLIGHT_DAYS` | `7` | Days to keep logs and flags, `1` to `30`. |
| `VOICE_MCP_FLIGHT_AUDIO_SECONDS` | `30` | Length of the in-memory audio ring, `5` to `60`. |

Commands: `mac-voice-mcp flag ["note"]` saves the last minute to `flight/flags/`; `mac-voice-mcp flight status` shows what is kept; `mac-voice-mcp flight purge` deletes it all. Claude can also call the `flag` tool, only when you ask it to; the note it writes is free text and can contain words you said. Only the `flag` tool saves audio: the command runs in its own process and can't reach the running server's memory, so in `audio` mode ask Claude to flag it. A running server's in-memory audio is not cleared by `flight purge`: restart voice-mcp to drop it. Flags: one per 10 seconds, 50 kept. `doctor` mentions it when it's on. (`VOICE_MCP_RECORDER` is the SoX/ffmpeg choice, unrelated.)

## Calls

| Variable | Default | |
|---|---|---|
| `VOICE_MCP_CALL_IDLE_MINUTES` | `30` | A call ends after this long with nothing said by you or Claude. Silence alone never ends it before then. |
| `VOICE_MCP_CALL_DUPLEX` | `auto` | Whether the mic stays open while Claude speaks on a call. `full`: yes, so you can talk over Claude; it pauses, drops the rest of its reply when you say something real, and carries on after a filler such as "mm-hmm". Use it only with headphones: on speakers the mic hears Claude. `half`: the mic is muted while Claude speaks. `auto`: `full` when the Mac's sound goes to headphones (the headphone jack, or Bluetooth that isn't a speaker), else `half`; checked once when the call starts. Windows calls are always `half`: speech can't be paused there. |
| `VOICE_MCP_AUDIO` | `process` | How a call plays and records sound on macOS 15 or later. `native`: through the audio worker, which cancels Claude's voice from the mic, on the Mac's own or wired speakers. Setup builds the worker after you agree. Other outputs, headphones and a forced `VOICE_MCP_CALL_DUPLEX` keep `process`. If the worker can't start, the call falls back to `process` until the server restarts. `process`: the recorder and player programs, as before. Experimental. |
| `VOICE_MCP_CALL_THINKING_SOUND` | `0` | `1`: after your words reach Claude on a call, a soft tick every 1.5 s until Claude speaks, for at most 10 s, so the call never goes silent. Off by default. macOS only. |
| `VOICE_MCP_CALL_BUBBLE` | `1` | `0`: never show the floating call bubble, even once it's built (see [Calls](usage.md#the-call-bubble-macos)). |
| `VOICE_MCP_LIVE_TRANSCRIPT` | `1` | `0`: don't show your words next to the call bubble while you speak (see [the call bubble](usage.md#the-call-bubble-macos)). Nothing runs with it off, with no bubble, or with `VOICE_MCP_WHISPER_SERVER=0`. |
| `VOICE_MCP_LIVE_TRANSCRIPT_MS` | `700` | How often the live transcript updates while you talk (400-2000 ms). Lower is snappier and uses more CPU. |

## Claude Code plugin hook

 Set this in the `env` block of `~/.claude/settings.json`, not in the server's config:

| Variable | Default | |
|---|---|---|
| `VOICE_MCP_STAY_IN_VOICE` | `1` | Set to `0` to stop the plugin's hook from sending Claude back to answer by voice. |

## Models

whisper.cpp model names:

| Model | Size | Good for |
|---|---|---|
| `tiny.en` | 75 MB | Yes/no answers, the lowest latency |
| `base.en` | 142 MB | **Default.** English conversation. |
| `small.en` | 466 MB | **Noisy rooms.** On real recordings with background noise: 8% of words wrong instead of 12% with `base.en`; the same in a quiet room. About 0.3 s per reply instead of 0.1 s on Apple Silicon. |
| `large-v3-turbo-q5_0` | 547 MB | Other languages, e.g. Thai with `VOICE_MCP_LANGUAGE=th` |

### The silence filter

whisper invents words for near-silent audio: in a quiet room `small.en` heard "Thank you." and repeated its hint. Setup offers to download the Silero VAD model (`ggml-silero-v5.1.2.bin`, under 1 MB, checked against its SHA-256) into the models folder, and only downloads it with your consent (`voice_setup` with `install=true`). Once it is there, whisper-server and whisper-cli run with `--vad -vm <model> -vp 400`, so whisper only hears the stretches with speech. On recorded room audio it blanked every silent stretch. The 400 ms padding keeps short replies whole: with 30 to 300 ms, "Flag that." came back as "Like that." or "It's like that.". Delete the file to turn the filter off.

**Plugin users:** the plugin's MCP server has no config block of its own. Set these in the `env` block of `~/.claude/settings.json` instead, then restart Claude Code.
