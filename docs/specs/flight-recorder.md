# Flight recorder and "flag that"

Status: shipped in 0.10.0 · Owner: Jeet · Source: `src/flight.ts`

## Goal

> "When a turn gets cut off, or Claude stops mid-sentence, I can say that was wrong, and later see why."

Today voice-mcp keeps nothing, so a bad turn can't be explained or reproduced. The flight recorder is an
opt-in, on-device log of what the voice pipeline decided (levels, why a turn ended, whether speech finished).
A flag saves the last minute of it, with an optional short audio clip, to a local file.

## Principles

- **Off by default.** Nothing is written unless the user turns it on.
- **On the Mac only.** The recorder has no network code: no upload, no telemetry, no crash reporting. A test
  checks the module imports nothing that can reach the network.
- **Numbers, not words.** The log holds timings, levels and reasons. It never holds transcripts or spoken text,
  only their lengths.
- **Audio is a second opt-in.** Kept only in memory, only the last few seconds, and written to disk only when
  the user flags a moment.
- **Short-lived.** Seven days, then deleted. A size cap. One command deletes everything.
- **Runtime dependencies unchanged** (zod only).

## Switch

| Setting | Values | Default |
|---|---|---|
| `VOICE_MCP_FLIGHT_RECORDER` | `off`, `on` (events), `audio` (events + in-memory audio ring) | `off` |
| `VOICE_MCP_FLIGHT_DAYS` | days to keep logs and flags, 1-30 | `7` |
| `VOICE_MCP_FLIGHT_AUDIO_SECONDS` | length of the audio ring, 5-60 | `30` |

(`VOICE_MCP_RECORDER` already picks SoX or ffmpeg, hence the `FLIGHT` name.)

When it is on, `doctor` says so, with the folder.

`flightMode()` reads the variable on every call instead of caching it, so the CLI and the tests see the
environment they were given. `on`, `1` and `true` all mean `on`; anything other than `on` or `audio` is
`off`. The two number settings are floored and clamped to their ranges; an empty or non-numeric value
gives the default. While the mode is `off`, every write function returns at once, so the recorder costs
nothing.

## Storage

- Folder: `<cache>/flight/` (the same cache root as models and the mic lock, `~/.cache/mac-voice-mcp` by default).
  Folder mode 0700, files 0600.
- Events: `events-YYYY-MM-DD.jsonl`, one JSON object per line.
- Flags: `flags/flag-<timestamp>.md`, and `flags/flag-<timestamp>.wav` when audio is on.
- Retention: on server start and once a day, files older than `VOICE_MCP_FLIGHT_DAYS` are deleted. Each day's
  event file is capped at about 10 MB (per process); past that, events are dropped for the day and one `recorder.full` line is written.
- Writes are best-effort: a failed write never breaks a turn. `flightEvent()` never throws.
- A symlinked `flight/` or `flags/` folder is refused, treated as "can't write". `flightFlag()` checks
  `flight/` first, so a symlinked folder is refused before anything is created inside it. The sweep and
  `flight status` use `lstat` and never follow or descend a symlink.
- The 10 MB cap counts bytes in memory per file, starting from the file's size on disk. The
  `recorder.full` line is written once per file per process.
- When the recorder is on, the sweep runs at server start and then once a day. When it is off but a
  `flight/` folder is left from an earlier run, one sweep runs at start, so old logs still expire.
- `flight purge` deletes the folder, the audio held in memory and the flag rate limit.

### The audio ring

In `audio` mode, `flightAudio()` keeps every 30 ms mic frame (16 kHz mono s16le) in memory. That is
everything the mic hears while voice-mcp has it open, not only speech. Frames older than
`VOICE_MCP_FLIGHT_AUDIO_SECONDS` are dropped, and so is anything past the frame count that length
allows. The first frame after leaving `audio` mode empties the ring.

## Events

Every line: `t` (ms since epoch), `ev`, `pid`, and `turn` (a per-process counter) where it applies.

| `ev` | When | Fields |
|---|---|---|
| `listen.start` | mic opens for a turn | `mode` (turn, call, worklisten), `maxMs`, `endSilenceMs`, `marginDb`, `minSpeechDb`, `chime` |
| `listen.end` | turn ends, or an utterance on a call. `cut`: the call mic stopped hearing the user mid-sentence (Claude speaking on speakers, or mute), so what they had said so far went on as the utterance | `reason` (end-of-turn, no-speech, max-duration, cut, stopped, typing, error), `totalMs`, `speechMs`, `speechStartMs`, `floorDb`, `speechDb`, `recentDb`, `recentSpreadDb` |
| `vad.discard` | a too-short sound is thrown away | `voicedMs` |
| `stt.done` | transcript ready | `ms`, `chars`, `words`, `droppedChars` (what `cleanTranscript` removed) |
| `speak.start` | speech starts | `engine` (say, kokoro), `chars`, `words`, `truncated` |
| `speak.end` | speech ends | `finished`, `reason` (done, stopped, barge-in, error, fallback, timeout), `ms`, `unspokenChunks` |
| `call.mute` | call mic muted or unmuted | `muted`, `why` |
| `call.event` | something happened on a call, as the call engine saw it (`src/call/engine/types.ts`, `Event`) | `type` (speech.onset, speech.dropped, utterance.ended, transcribed, transcribe.failed, words.checked, say.requested, playback.ended, inbox.drained, end.requested, tick), `at`, and that type's fields: `utterance` and `say` are counters, `reason`, `heard` (words, filler, hang-up, empty), `words` (true, false, or null when whisper couldn't take the check in time), `quietMs` |
| `call.effect` | one thing the engine decided to do about the `call.event` before it (`Effect`) | `type` (speech.start, speech.duck, speech.restore, speech.pause, speech.resume, speech.stop, speech.drop, deliver, words.check, cue, teardown), `say`, `utterance`, `interrupted.say`, `interrupted.playedMs`, `missed`, `sound`, `reason` |
| `listen.cut` | the call mic stopped hearing the user (Claude speaking on speakers, or mute) before they had talked for 250 ms, dropping it | `speechMs` |
| `stop.seen` | a stop request ends speech or listening | `stopAt`, `ownStartAt` |
| `audio.fallback` | the native audio worker couldn't start, so the call uses the recorder | `ms` |
| `audio.lost` | the native audio worker ended mid-call (a device changed, the mic stalled, or it died) | `routeChanged` |
| `flag` | user flagged a moment | `id`, `hasNote` |

String fields are an allowlist per event (reasons, engine, mode, why, the flag id), in `STRINGS`; any other string is dropped, so even a one-word transcript can't land in a field. The allowlist of `call.event` and `call.effect` is built from the engine's own type tables (`EVENT_STRINGS`, `EFFECT_STRINGS`), which don't compile unless they list every event, effect and string field. Every decision of a call is in the log: talking over Claude is `speech.pause`, then `speech.resume` or `speech.stop`; on the native backend it is `speech.duck`, `words.check` and its `words.checked`, then `speech.pause`, `speech.restore` or `speech.stop`; a reply that waited for the user on speakers is a `say.requested` whose `speech.start` comes with a later event. No event carries transcript text, spoken text, file paths of audio, or tool arguments.

How `clean()` treats each field:

- Numbers are rounded to two decimals. A non-finite number becomes `null`.
- Booleans and `null` pass as they are.
- A string passes only if the allowlist names that event, that field and that value. The flag `id` must
  match `^\d{8}-\d{6}-\d{3}$`. The `listen.end` and `speak.end` reason lists also accept `timeout`.
- `engineStrings()` folds one engine table into one allowlist: `type` takes every event or effect name,
  and each string field takes every value it has in any of them.
- `recordStep()` writes one `call.event` line and then one `call.effect` line per effect, with no `turn`.
  Nested fields are flattened with dots, so `interrupted: { say, playedMs }` becomes `interrupted.say` and
  `interrupted.playedMs`.
- `flightTurn()` starts a new turn number. Events after it carry that number until the next turn.
- `stop.seen` reads `at` from the stop file the plugin writes when the user's typing stops speech or
  listening.

## Flagging

- **MCP tool `flag`** (`note` optional, up to 500 characters, the user's own words). Writes the flag file and
  returns its path. In `audio` mode it also writes the ring as a WAV (16 kHz mono).
- **CLI `mac-voice-mcp flag [note]`**: same, without audio (the ring lives in the server).
- The flag file holds: time, note, version, macOS version, the voice settings in effect (no secrets, no paths
  outside the cache), a one-line summary ("last turn ended by max-duration after 30.0 s; last reply finished:
  no, stopped"), and the last 60 s of events.
- The flag file stays on the Mac. Copying it into an issue is the user's choice.
- **CLI `mac-voice-mcp flight status|purge`**: show whether it is on, the folder and its size; delete the folder.

Rules for `flightFlag()`:

- It works while the recorder is on, or when an earlier run left a `flight/` folder. The CLI runs in its own
  process, so it relies on the second case. With neither, it returns `null`.
- A second flag within 10 s (`MIN_FLAG_GAP_MS`) writes nothing and returns "Already flagged just now.", so a
  stuck loop can't fill the disk.
- At most 50 flags are kept (`MAX_FLAGS`). Before a new one is written, the oldest go, with their WAVs. The
  file name is a UTC timestamp (`flag-YYYYMMDD-HHMMSS-mmm.md`), so sorting the names sorts by age.
- The note has its whitespace collapsed and is cut at 500 characters.
- The WAV is written only in `audio` mode, when the caller asks for audio and the ring holds frames.
- Files are created with the `wx` flag, so a flag never overwrites one. If the markdown write fails, the
  WAV is deleted, so no audio is left without its flag file.
- The events come from yesterday's and today's files, oldest first. A half-written line is skipped.
- The summary re-checks each reason against the allowlist and prints `unknown` for anything else.
- The settings block holds `tts`, `voice`, `rate`, `kokoroVoice`, `language`, `model`, `endSilenceMs`,
  `startTimeoutSeconds`, `speechMarginDb`, `minSpeechDb`, `recorder`, `callDuplex` and `flightRecorder`.
- A `flag` event is logged once the file is saved.

## Out of scope (later)

- Saying "flag that" on a call (needs a command matcher in the call loop).
- `replay <flag>`: run saved levels or audio back through the endpointer offline.
- Automatic flags on suspicious turns.
- Per-frame level traces.

## Acceptance

- Off by default: with the variable unset, a full stubbed turn creates no `flight/` folder.
- On: a stubbed turn writes `listen.start`, `listen.end` with the end reason, `stt.done`, `speak.start`, `speak.end`.
- No event contains the transcript or spoken text (test with a unique marker word).
- `flag` writes the markdown file with the summary and recent events; with `audio`, a valid WAV of at most
  `VOICE_MCP_FLIGHT_AUDIO_SECONDS`; without it, no WAV.
- Files older than the retention are deleted; `purge` removes the folder; files are 0600, folder 0700.
- The recorder module imports no network module (`http`, `https`, `net`, `tls`, `dgram`, `fetch`).
- `docs/privacy-security.md` describes it accurately. Privacy review signed off.
- `npm test` passes.
