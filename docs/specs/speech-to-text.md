# Speech to text

Source: `src/stt.ts`, `src/wer.ts`.

voice-mcp turns the user's recorded reply into text with whisper.cpp, on the device. Knobs are listed in
[configuration](../configuration.md). Cleaning the transcript (whisper's invented sentences, such as the
phantom "Thank you.") lives in `src/speech-text.ts` and is covered in [speech output](speech-output.md).

## Two engines

The fast path is a warm `whisper-server` on 127.0.0.1. It keeps the model loaded between turns, so each
reply skips the model load, and on Apple Silicon the Metal start-up too. `prewarm` starts it in the
background while the question is being spoken. After `VOICE_MCP_SERVER_IDLE_MINUTES` with no use it stops,
to give the memory back. Every start and every transcription resets that timer.

The fallback is `whisper-cli`, one process per transcription. It is always correct, just slower.
`transcribeNow` tries the server first when it is usable. If the server fails for any reason other than a
cancel, it logs the error, stops the server, and runs `whisper-cli` instead. A cancel throws
`CancelledError` and never falls back.

The server is usable when `VOICE_MCP_WHISPER_SERVER` is not `0`, a `whisper-server` binary is found, and
the server is not disabled. Two failed starts in a row disable it for the rest of the session. An old
whisper.cpp build that cannot run the server should not cost a failed start on every turn. A successful
start resets the count.

## Finding the binaries

`findWhisperCli` honours `VOICE_MCP_WHISPER_BIN` first. Then it looks on `PATH` for `whisper-cli`, the name
Homebrew's `whisper-cpp` formula uses, and the older names `whisper-cpp` and `whisper-cpp-cli`. Last, it
looks for a whisper.cpp the user built and never put on `PATH`. It checks `whisper.cpp/build/bin` and
`whisper.cpp` under the home folder and under the usual project folders (`src`, `code`, `dev`,
`Developer`, `projects`, `workspace`, `git`, `repos`, `GitHub`, `Downloads` and their capitalised
forms). Old source builds name the CLI `main`.

`findWhisperServer` honours `VOICE_MCP_WHISPER_SERVER_BIN`, then `whisper-server` on `PATH`, then a
sibling of the CLI it found. Next to an old `main` it also accepts `server`.

## Starting the warm server

The server listens on a free port that the OS picks, on 127.0.0.1 only. It gets the model, the thread
count, the language, `-nt` (no timestamps), the silence filter flags and the whisper hint.
`fetchWithin` gives each HTTP call a timeout and also follows the caller's abort signal. It links the two
by hand so it works without `AbortSignal.any`.

Start-up polls `/health` every 100 ms for up to 180 s, because large models can take a while to load.
A 503 means the model is still loading. A 404 comes from an older server without `/health`, and it counts
as ready. If the server exits during start-up, the wait stops at once and the error carries the last lines
of its stderr.

### Orphan guard

The server must not outlive the MCP process, even when that process is killed hard. On macOS and Linux it
runs under a tiny shell with a fixed script:

```sh
{ "$@" </dev/null; kill $$; } & read -r _; kill 0
```

The shell waits on our stdin pipe. When the pipe closes, which happens whenever this process exits, it
kills its whole process group, server included. `detached` gives it that process group, so `stop()` can
also end it as one with `SIGTERM`. A server that exits by itself (an unknown flag, a bad model) takes the
shell with it, so start-up sees the exit instead of polling `/health` until the deadline.

The script is a fixed string. The binary and its arguments, which include the model path and
`VOICE_MCP_WHISPER_PROMPT`, reach the shell as positional parameters, and `"$@"` passes each one on as a
single word. The shell never parses or expands them. A test in `test/e2e.test.mjs` checks this with shell
characters in those settings. On Windows the server is spawned directly.

## Transcribing

`transcribe` takes a WAV file and `transcribeBuffer` takes WAV bytes in memory. The turn path uses the
buffer, so with the warm server the audio never touches the disk. `whisper-cli` only reads files, so the
fallback writes the buffer to a private temp folder and deletes it afterwards. That is the one place audio
from memory reaches the disk.

The server request uses `temperature` 0.0 with `temperature_inc` 0.2 and asks for JSON. A transcription
times out after 120 s on the server and 180 s with the CLI.

When a caller passes `dropped`, it receives whatever cleaning removed as invented text. The `stt.done`
flight event logs the time, the character and word counts, and `droppedChars`, the number of characters
cleaning removed. It logs only the number, never the text. See [flight recorder](flight-recorder.md).

## Partial transcripts

`transcribePartial` serves the [live transcript](live-transcript.md). It uses the warm server only, with
audio from memory and a 5 s timeout. `partialsAvailable` is true only while that server is up, and it never
starts a server or falls back to `whisper-cli`. Any failure or abort resolves `null`, with nothing logged.
Partial words are display only, so they never reach a log, even with `VOICE_MCP_DEBUG`.

## Silence filter (Silero VAD)

whisper invents words for near-silent audio. With the Silero VAD model in the models folder and a
whisper.cpp that lists `--vad` in its `--help`, both engines run with `--vad -vm <model> -vp 400`, so
whisper only hears the stretches with speech. Builds from before VAD exit on `--vad`, so `supportsVad`
asks each binary once. It caches the answer per real path, because a Homebrew upgrade swaps the binary
behind the same link. Added in #62. Setup and the download are described in
[configuration](../configuration.md).

The padding (`VAD_PAD_MS`, 400) is the speech the filter keeps on each side of what it detects. On whole
recorded utterances, 30 to 300 ms turned "Flag that." into "Like that." or "It's like that.". 350 ms and up
kept it, and silences stayed empty up to 1000 ms.

## The whisper hint

`VOICE_MCP_WHISPER_PROMPT` is passed as `--prompt` to both engines. It tells whisper which words to expect.
The default list, its measured effect and how to turn it off are in [configuration](../configuration.md).

## Setup report

`describeStt` says which engine the next transcription will use for the setup report. It names the CLI
path, "fast mode via whisper-server" when a server is found (or that `VOICE_MCP_WHISPER_SERVER=0` turned it
off), and "silence filter (Silero VAD)" when the filter is active.

## Word error rate

`src/wer.ts` measures how far a transcript is from the words that were actually said, so "it heard me
right" is a number, not a feeling. `doctor` and the round-trip tests use it.

`wordErrorRate(reference, hypothesis)` returns `wer`, `errors` and `words`. `wer` is (substitutions +
deletions + insertions) / reference words, so 0 is perfect. It is the word-level edit distance between the
two. With an empty reference, any heard word scores 1.

Both sides pass through `normalizeWords` first:

- lower case;
- whisper's bracketed annotations such as `[BLANK_AUDIO]` and `(music)` removed;
- thousands separators dropped (`1,000` becomes `1000`);
- punctuation becomes a word break, so `index.ts` is `index ts`, and apostrophes are removed;
- numbers of one to three digits spelled out with `numberToWords`, so `60` and `sixty` count as the same
  word. `numberToWords` covers 0 to 999 only (`42` becomes `forty two`).
