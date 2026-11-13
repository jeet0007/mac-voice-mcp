# Flight recorder and "flag that" (unreleased)

Status: in progress · Owner: Jeet · Target: next minor

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

## Storage

- Folder: `<cache>/flight/` (the same cache root as models and the mic lock, `~/.cache/mac-voice-mcp` by default).
  Folder mode 0700, files 0600.
- Events: `events-YYYY-MM-DD.jsonl`, one JSON object per line.
- Flags: `flags/flag-<timestamp>.md`, and `flags/flag-<timestamp>.wav` when audio is on.
- Retention: on server start and once a day, files older than `VOICE_MCP_FLIGHT_DAYS` are deleted. Each day's
  event file is capped at about 10 MB (per process); past that, events are dropped for the day and one `recorder.full` line is written.
- Writes are best-effort: a failed write never breaks a turn.

## Events

Every line: `t` (ms since epoch), `ev`, `pid`, and `turn` (a per-process counter) where it applies.

| `ev` | When | Fields |
|---|---|---|
| `listen.start` | mic opens for a turn | `mode` (turn, call, worklisten), `maxMs`, `endSilenceMs`, `marginDb`, `minSpeechDb`, `chime` |
| `listen.end` | turn ends | `reason` (end-of-turn, no-speech, max-duration, stopped, typing, error), `totalMs`, `speechMs`, `speechStartMs`, `floorDb`, `speechDb`, `recentDb`, `recentSpreadDb` |
| `vad.discard` | a too-short sound is thrown away | `voicedMs` |
| `stt.done` | transcript ready | `ms`, `chars`, `words`, `droppedChars` (what `cleanTranscript` removed) |
| `speak.start` | speech starts | `engine` (say, kokoro), `chars`, `words`, `truncated` |
| `speak.end` | speech ends | `finished`, `reason` (done, stopped, barge-in, error, fallback, timeout), `ms`, `unspokenChunks` |
| `bargein` | pause, resume, drop | `action`, `ms` |
| `call.mute` | call mic muted or unmuted | `muted`, `why` |
| `stop.seen` | a stop request ends speech or listening | `stopAt`, `ownStartAt` |
| `flag` | user flagged a moment | `id`, `hasNote` |

String fields are an allowlist per event (reasons, engine, mode, action, why, the flag id); any other string is dropped, so even a one-word transcript can't land in a field. No event carries transcript text, spoken text, file paths of audio, or tool arguments.

## Flagging

- **MCP tool `flag`** (`note` optional, up to 500 characters, the user's own words). Writes the flag file and
  returns its path. In `audio` mode it also writes the ring as a WAV (16 kHz mono).
- **CLI `mac-voice-mcp flag [note]`**: same, without audio (the ring lives in the server).
- The flag file holds: time, note, version, macOS version, the voice settings in effect (no secrets, no paths
  outside the cache), a one-line summary ("last turn ended by max-duration after 30.0 s; last reply finished:
  no, stopped"), and the last 60 s of events.
- The flag file stays on the Mac. Copying it into an issue is the user's choice.
- **CLI `mac-voice-mcp flight status|purge`**: show whether it is on, the folder and its size; delete the folder.

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
