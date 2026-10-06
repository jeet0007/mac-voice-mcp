# Configuration

[← README](../README.md) · [Install](install.md) · [Voices](voices.md) · [Using it](usage.md) · [Configuration](configuration.md) · [Troubleshooting](troubleshooting.md) · [Privacy & security](privacy-security.md) · [Development](development.md)

Everything is optional. Set these in your client config's `"env": { … }` block, or with `-e NAME=value` in `claude mcp add`.

## Speaking

| Variable | Default | |
|---|---|---|
| `VOICE_MCP_VOICE` | most natural installed | Unset: the best Premium or Enhanced voice installed for the language, else the system voice. Set a name, e.g. `Ava (Premium)`, `Daniel`, `Kanya` (list them with `say -v '?'`), or `default` to always use the system voice. |
| `VOICE_MCP_RATE` | system rate | Words per minute, e.g. `200` (macOS voices). |
| `VOICE_MCP_TTS` | `auto` | `auto`: the [Kokoro voice](voices.md#the-kokoro-voice-optional) once it's installed, else the built-in voice. `say`: always the built-in voice. `kokoro`: Kokoro, and setup offers to install it. |
| `VOICE_MCP_KOKORO_VOICE` | `af_heart` | Kokoro voice. American English starts with `a`, British with `b`, e.g. `af_bella`, `am_michael`, `bf_emma`, `bm_george`. |
| `VOICE_MCP_KOKORO_SPEED` | `1` | Kokoro speaking speed, `0.5` to `2`. |
| `VOICE_MCP_KOKORO_DTYPE` | `fp32` | `q8`: a smaller model (~90 MB instead of ~330 MB) that's about half as fast. |
| `VOICE_MCP_KOKORO_DIR` | `~/.cache/mac-voice-mcp/kokoro` | Where the Kokoro voice is installed. |
| `VOICE_MCP_MAX_SPEAK_WORDS` | `120` | Longer text is cut at a sentence boundary ("the rest is on screen"). |
| `VOICE_MCP_CHIME` | `1` | Set to `0` to turn off the mic open/close sounds. |
| `VOICE_MCP_LOCK_WAIT_SECONDS` | `120` | How long a turn waits while another session on this Mac is using the mic. |

## Listening

| Variable | Default | |
|---|---|---|
| `VOICE_MCP_END_SILENCE_MS` | `1200` | How long a pause ends your turn. Use `1800` if it cuts you off while you think, `800` for snappier replies. |
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
| `VOICE_MCP_WHISPER_PROMPT` | — | Words to bias toward: names, product terms, jargon. |
| `VOICE_MCP_WHISPER_MODEL_PATH` | — | Use this exact `ggml-*.bin` file. |
| `VOICE_MCP_MODEL_SEARCH_PATHS` | — | Extra folders to check for an existing model (`:`-separated). |
| `VOICE_MCP_WHISPER_SERVER` | `1` | Set to `0` to always use `whisper-cli`, with no warm server. |
| `VOICE_MCP_SERVER_IDLE_MINUTES` | `15` | How long the warm server stays up without use. |
| `VOICE_MCP_THREADS` | min(8, cores) | Number of whisper.cpp threads. |
| `VOICE_MCP_CACHE_DIR` | `~/.cache/mac-voice-mcp` | Where models are downloaded or symlinked. |
| `VOICE_MCP_DEBUG` | `0` | Verbose logs with per-turn timings, written to stderr. |

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
| `small.en` | 466 MB | Noticeably more accurate English |
| `large-v3-turbo-q5_0` | 547 MB | Other languages, e.g. Thai with `VOICE_MCP_LANGUAGE=th` |

**Plugin users:** the plugin's MCP server has no config block of its own. Set these in the `env` block of `~/.claude/settings.json` instead, then restart Claude Code.
