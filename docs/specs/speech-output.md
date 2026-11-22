# Speech output

Source: `src/speech-text.ts`, `src/kokoro-text.ts`, `src/kokoro.ts`, `src/kokoro-worker.ts`,
`src/speech/synthesize.ts`, `src/speech/replies.ts`, `src/pcm.ts`

This spec explains how voice-mcp turns the text Claude sends into sound. It covers the text clean-up, the two
voices (the built-in voice and the optional Kokoro voice), how Kokoro text is cut into chunks, the pauses
between chunks, and how a reply falls back when Kokoro fails. Where the sound plays is the audio backend's job
(see [audio.md](audio.md)). The knobs named here are listed in [configuration.md](../configuration.md).

## The path of a reply

`speak(text, signal)` in `speech/replies.ts` is the one entry point. It synthesizes, then plays, and returns a
`Reply` with `done`, `duck`, `pause`, `resume` and `stop`. It is stateless and has no queue. Each caller orders
its own replies. The call plays its `say`s one after another, and a turn speaks, then listens.

`done` resolves with a `Spoken` record once the reply has finished. It rejects with `CancelledError` once the
reply is stopped, or with the reason it could not be spoken. Aborting the caller's `signal` is the same as
`stop()`. `duck(gain)` below 1 makes the reply quieter (on the process backend it pauses it), and 1 restores
it. `duck`, `pause` and `resume` also reach the built-in voice when it takes over from Kokoro, because the
reply remembers the gain and the paused state and applies them to every playback it starts.

Each reply writes `speak.start` and `speak.end` events to the flight recorder (see
[flight-recorder.md](flight-recorder.md)). `speak.end` carries `reason`, one of `done`, `fallback`, `stopped`
or `error`.

## Screen text to ear text

Claude is asked (in the tool description, the server instructions and the `voice_mode` prompt) to send plain
spoken sentences. `prepareSpeech` in `speech-text.ts` is the safety net for whatever slips through, so the
user never hears "backtick backtick backtick" or a 40-segment file path read aloud. It is pure and
unit-tested.

It rewrites, in this order:

- Fenced code blocks become "(I've left the code on screen.)" and markdown tables become "(There's a table on
  screen.)".
- Inline code stays when it is short and word-like (32 characters or fewer, no `{}();=<>[]$`). Otherwise it
  becomes "that code".
- Images become their alt text, links their link text, and stray HTML tags are removed.
- A bare URL becomes "a link to" its host.
- A long file path becomes its file name. A run of digits and slashes is left alone, because it is a date such
  as 9/23/2026. `index.ts:120` becomes `index.ts`, and `42/42` becomes "42 of 42".
- Headings, quotes, bullets and numbered items each become their own sentence. A line without closing
  punctuation gets a full stop.
- Emphasis markers and emoji are removed. Arrows become "to", and a spaced `&` becomes "and".

### The one-word opener

A one-word opener such as "Okay. This is what I found" runs into the next sentence as "Okay, this is what I
found". Voices pause after a full stop, and after a one-word sentence that pause stands out. With Siri Voice 4
the longest pause in such replies fell from about 0.5 s to 0.3 s on average. `OPENER` lists the words that
count.

### Length limits

Over `maxWords` words (default 120, `VOICE_MCP_MAX_SPEAK_WORDS`), the text is cut at the last sentence end, if
that falls past 40% of the kept words, and "The rest is on screen." is added. A hard cap of `maxChars` (4000)
characters applies after that.

### Notes back to Claude

`prepareSpeech` returns `notes` alongside the text. Each note tells Claude what was rewritten (code blocks,
tables, inline code, URLs, file paths) or cut, so its next spoken text is plainer.

When the input points the user at something to look at ("I've put it below", "see the diff", "on screen"),
a reminder note says that only Claude's own assistant message renders. Spoken text and Bash or tool output are
not visible to the user ([issue #3](https://github.com/jeet0007/mac-voice-mcp/issues/3)). The check runs on the
original input, so the added "The rest is on screen." does not trigger it. `ON_SCREEN_PATTERN` is
deliberately specific. Bare words such as "above", "below" or "see the" also occur in ordinary speech ("above
thirty degrees", "see the doctor") and must not trigger the reminder.

## Cleaning whisper transcripts

`speech-text.ts` also holds `cleanTranscript`, which turns whisper's raw output into just the words. The rest
of speech-to-text is in [speech-to-text.md](speech-to-text.md).

- Stray timestamps such as `[00:00.000 --> 00:02.000]` are removed.
- `SOUND_NOTES` are removed. These are whisper's notes about sounds rather than words, and never something the
  user said. Examples are `[BLANK_AUDIO]`, `[MUSIC PLAYING]`, `[gunshot]` (heard for a cough), `[APPLAUSE]`
  (for typing), `(sound of running)` (for a fan), `*laughs*` and ♪.
- `STOCK_SENTENCES` are dropped. Whisper invents these from the videos it learned from, typically on noise or
  a clipped start: "Thanks for watching", "Like and subscribe", "Find the links in the description", "See you
  in the next video", and credit lines such as "Subtitles by…". Only whole sentences that nobody says to a
  coding assistant are listed. "Thank you." and "Bye." are real answers and stay.
- A bare credit word (`LOOSE_CREDITS`, such as "Transcription." or "Subtitles") is dropped only when it is the
  whole transcript. "Transcription is wrong." is kept.

Sentences are split at `.`, `!` or `?` followed by a space or the end, so the dot in "1.2.3" or "Amara.org"
does not end a sentence. Each dropped sentence is pushed to the optional `dropped` array, for the flight
recorder.

## The built-in voice

The built-in voice is macOS `say`, espeak-ng (or espeak) on Linux, and Windows SAPI through PowerShell.
`findTts` finds it. `builtInCommand` returns the command line that the audio backend runs. Every engine reads
the text from stdin. That avoids argv length limits and flag injection, and it lets a voice process start
ahead of time and wait for its text.

`standby` asks the backend to keep one voice process waiting for the next reply. macOS loads the voice each
time it speaks, which took about 1.4 s with a Siri voice before the first word. With a process waiting, the
wait beyond the speech itself fell to 0.6 s on 8 test replies with Siri Voice 4. Standby is on unless
`VOICE_MCP_VOICE_STANDBY` turns it off, and it is off whenever Kokoro is in use, because then the built-in voice
only fills in.

### Which macOS voice

`chooseVoice` decides once and caches the answer. `resetVoiceChoice` clears it, so `voice_setup` picks up a
voice downloaded meanwhile.

- `VOICE_MCP_VOICE` unset or `default` uses the voice set in System Settings (`say` without `-v`).
- `best` runs `say -v '?'`, parses it with `parseSayVoices`, and picks with `pickVoice`. That takes only
  Premium (quality 3) and Enhanced (quality 2) voices in the language, Premium first, then voices in the
  system's region (en_US over en_GB on a US Mac), then by name. If none is installed, it keeps the system voice
  and reports that a download would help (`VOICE_UPGRADE_HINT`).
- Any other value is passed to `say -v` as is.

`VOICE_MCP_RATE` becomes `say -r`.

## The Kokoro voice

Kokoro-82M (Apache-2.0) is an on-device neural voice that sounds much closer to a person than `say`. It is off
until the user installs it with `voice_setup` and `kokoro=true` (see [setup-and-doctor.md](setup-and-doctor.md)).
Nothing is bundled with the package and nothing is downloaded without that consent.

`kokoroEnabled` decides. `VOICE_MCP_TTS=say` always uses the built-in voice, `kokoro` always uses Kokoro, and
`auto` (the default) uses Kokoro once kokoro-js and the model for the configured precision are both on disk.

### Installing

`installKokoro` writes a `package.json` into `VOICE_MCP_KOKORO_DIR` (default `~/.cache/mac-voice-mcp/kokoro`)
and runs `npm install kokoro-js@1.2.1` there (`KOKORO_JS_VERSION`, the release we install and test against).
The `package.json` is created with the `wx` flag, so creating it is one step with no check-then-write race.
npm comes from the same Node installation that runs the server, else from `PATH`. Because npm is a Node
script, the install puts this Node's folder first on `PATH`, so it works from a GUI app's minimal `PATH`.

It then writes `entry.mjs`, which re-exports `KokoroTTS` from kokoro-js and `env` from
`@huggingface/transformers`. Both come from the same install, so the worker's settings reach the same
transformers instance kokoro-js uses. The file is rewritten on every install, which repairs an edited or stale
one.

Last, it starts the worker once with downloads allowed. That downloads the model if it is missing and doubles
as the install's self-test. The worker is then stopped, so the next turn starts it normally with downloads
off. Model sizes are about 326 MB for fp32 and 92 MB for q8 (`KOKORO_SIZES_MB`). fp32 is the default because
it is about twice as fast on a CPU.

### The worker process

The model takes seconds to load and holds hundreds of MB, so it runs in its own process
(`kokoro-worker.ts`), kept warm between turns, instead of inside the MCP server. If it crashes or leaks, the
server starts a fresh one. `kokoroWorker` in `kokoro.ts` is the one instance.

The server passes settings through the environment: `KOKORO_DIR`, `KOKORO_DTYPE`, `KOKORO_VOICE`,
`KOKORO_SPEED`, and `KOKORO_ALLOW_DOWNLOAD`, which is `1` only during an install the user agreed to. An
unknown voice falls back to `af_heart`.

The protocol is one JSON object per line.

| Direction | Message |
| --- | --- |
| in (stdin) | `{type:"speak", id, chunks:[text…]}`, `{type:"cancel", id}` |
| out (fd 3) | `{type:"ready", voice, voices, loadMs}` |
| out (fd 3) | `{type:"progress", message}` (model download, in 10% steps) |
| out (fd 3) | `{type:"audio", id, seq, pcm}` where `pcm` is base64 16-bit little-endian, 24 kHz mono |
| out (fd 3) | `{type:"done", id, cancelled, rssMb}` |
| out (fd 3) | `{type:"error", id?, message, fatal?}` |

Messages go on fd 3, not stdout, because libraries print to stdout (kokoro-js prints a voice table). Stdout
and stderr are kept as a 3000-character log tail, which is quoted when the worker exits.

The worker handles one request at a time. A cancel marks the request, and the loop stops before the next
chunk. Generating blocks the worker's event loop, so it yields (`setImmediate`) between chunks to read a
cancel from stdin. On the server side a cancel stops waiting at once and resolves the request as cancelled.
When the server closes the worker's stdin (it exited or was killed), the worker finishes its current request
and exits. When fd 3 fails, the server went away and the worker exits.

### Lifetimes and limits

- **Load.** A model already on disk loads in a few seconds. The load timeout is 120 s for a slow, busy
  machine, and 30 minutes during an install, when the download may be slow.
- **Stall.** If the worker produces no chunk of audio for `VOICE_MCP_KOKORO_STALL_SECONDS` (default 30 s), it
  counts as stuck. It is killed, and the built-in voice finishes the reply. A chunk takes a second or two, so
  this is generous enough that a busy Mac does not trigger it. Without it, a worker that stopped answering
  would mean silence for good.
- **Memory.** onnxruntime can grow over a long session. A worker that reports more than 1500 MB of resident
  memory after a request is stopped, and the next reply starts a fresh one.
- **Idle.** A worker unused for `VOICE_MCP_SERVER_IDLE_MINUTES` is stopped to free memory.
- **Stop.** Stopping closes the worker's stdin, and the worker exits on its own. If it is still running 2 s
  later, it gets `SIGKILL`.

`prewarmKokoro` loads the model in the background when a call starts or listening begins, so the next reply
is not a cold start after an idle stop or a recycle. It runs only when Kokoro is in use and its files are on
disk, so it never downloads. A worker that is already running is left alone, so its idle timer is not
extended.

## Kokoro text

Kokoro reads text through espeak-ng. espeak trips over some developer jargon, silently stops at a newline, and
truncates anything past about 510 tokens. `prepareForKokoro` in `kokoro-text.ts` handles all three. It is pure
and unit-tested.

### Pronunciation

`PRONUNCIATIONS` replaces words espeak gets wrong, in order. JSON is said "jay-son", YAML "yammel", SQLite
"S Q lite", RAM "ram", and GIF "gif". A file name becomes "file dot ext", and short extensions are spelled out
letter by letter, so `index.ts` is "index dot T S" (json and yaml are said as words). A version number such as
1.2.3 becomes "1 point 2 point 3", because espeak reads it as a decimal.

### Chunking

Kokoro generates and plays the text chunk by chunk. The next chunk is generated while the current one plays.
`chunkForSpeech` decides the chunks, and it never loses or reorders text.

- **The first chunk is short.** Nothing plays until it is generated. It is the first sentence, else its first
  clauses, else its first words, up to 60 characters of weight (`FIRST_CHUNK_CHARS`).
- **Later chunks grow.** Each one may be at most twice the weight of the chunk before it (`GROWTH`), up to 250
  (`MAX_CHUNK_CHARS`), which is well under Kokoro's token limit. On an M-series Mac Kokoro makes speech about
  2.8 times faster than it plays: 19 ms per character for 59 ms of audio, plus about 290 ms per chunk.
  Trimming the edge silence (below) leaves less to play, so the growth is 2 rather than nearer 2.8.
- **Breaks fall at sentences and clauses.** A chunk holds whole sentences, else whole clauses. A clause over
  the growth budget is taken whole, because a pause at a bare space sounds broken. Only the first chunk, or a
  clause over 250, is cut between words. That cut prefers the spot just before a function word ("and",
  "because", "with" and so on) past half-way.
- **A word over the limit is cut inside it.** A long URL or hash would otherwise be truncated by Kokoro.
- **Short pieces ride along.** A sentence or clause under 18 characters (`MIN_PIECE_CHARS`) joins its
  neighbour, so "not me." is never spoken alone.
- **Abbreviations do not end sentences.** "Dr.", "Mr.", "e.g.", "etc." and the others in `ABBREVIATION` join
  the next sentence.
- **Clause breaks need a space after them**, so "1,000" and "12:30" stay whole.
- **Weight counts digits and capitals twice.** They are read out one by one, so they cost Kokoro about twice
  the tokens.

Newlines become full stops first, because Kokoro stops at a newline. "Done:" followed by a newline stays
"Done:" rather than "Done:.". Text with no letter or digit gives no chunks, and nothing is said.

Before this design, a short first sentence followed by a long one ("Sure." then 150 characters) left the
speaker silent while the long one generated. On 12 typical replies on the owner's Mac, 2 paused, the worst for
1.4 s. With growing chunks none paused, and the first sound still came after about 0.65 s
([#64](https://github.com/jeet0007/mac-voice-mcp/issues/64), [PR #67](https://github.com/jeet0007/mac-voice-mcp/pull/67)).

## Kokoro audio

`kokoroSpeech(text, signal)` in `speech/synthesize.ts` turns the chunks into a streaming `Sound` of kind
`speech`, one 24 kHz PCM buffer per chunk as soon as it is generated. `load()` starts the worker (and reports a
cold start when it was not running), then returns the sound, or null when there is nothing to say. It throws
if Kokoro cannot start. `unspoken()` returns the chunks not yet handed to the player. `stats` records the time
from the call to the first sound, and whether the model was loaded for this turn.

If the caller aborts, or the player stops reading, the generator cancels the worker request.

### Edge trimming and pauses

Kokoro pads each chunk with about 0.3 s of near-silence before and 0.5 s after, so every chunk boundary used to
be about 0.9 s quiet, mid-clause or not. `withPause` trims each chunk to its first and last sample at or above
-40 dBFS, keeping 30 ms before and 50 ms after. It then adds the pause the chunk's ending calls for, unless it
is the last chunk.

| Chunk ends with | Pause |
| --- | --- |
| `.`, `!`, `?` or `…` | 350 ms |
| `,`, `;`, `:` or a dash | 200 ms |
| anything else (a cut between words) | none |

Closing quotes and brackets after the mark still count. Trimming the lead silence also brings the first sound about a quarter second sooner. The 350 ms and 200 ms values are placeholders until
the owner's listening test ([#64](https://github.com/jeet0007/mac-voice-mcp/issues/64)).

## Falling back

A broken Kokoro install must never make the server mute. In `speech/replies.ts`, if Kokoro fails to load or
fails partway, the built-in voice says whatever Kokoro had not yet handed to the player. The log says why, and
`Spoken.fallback` carries the reason. A cancel is never treated as a failure, so a stopped reply stays
stopped.

## Speech into a file

`synthesizeToFile` speaks text into a 16 kHz mono 16-bit WAV instead of the speakers, with the same voice
replies use. `doctor` and the round-trip tests use it. A Kokoro failure is an error here, not a fallback.
Kokoro's 24 kHz output is resampled to 16 kHz with `resamplePcm16`. That is linear interpolation, which is
good enough for speech recognition, the only use. Playback always uses the original rate.

Sometimes `say` exits cleanly but writes almost no audio, for example when the voice's speech data is not
available. For text of more than two words, under 0.3 s of audio is retried once. A second short result is an
error that names the voice and suggests another, instead of handing silence to whisper.

`wavData` finds the data chunk by walking the RIFF chunks, because `say` may add chunks before it.
