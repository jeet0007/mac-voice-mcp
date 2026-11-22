# Call audio redesign: final design (after an adversarial review)

Synthesized from two candidate designs (ports and adapters around one audio port; a pure call engine) and an adversarial review.

## Synthesis decision

Base: **A's audio port**. It is the deeper module: three exports (`openAudio`, `play`, types) hide backend choice,
fallback, mic ownership, echo handling, playback routing and how ducking is done. `Purpose` is one enum
instead of four flags. `Frame.echo` moves "half duplex" into data the device owns, so no consumer branches on duplex.

Graft: **B's pure call engine** replaces A's `barge-in.ts` class plus the imperative policy in A's `call/call.ts`.
Reasons: the call has six interacting timers and flags today (muteUntil, saysPending, thinkingSince, lastTickAt,
userTalking, heardWhileSaying); the audit of PR #52 found the thinking-tick fix untestable because `Call` needs real
audio. B's `ClaudeTurn`/`UserTurn` unions make the illegal combinations unrepresentable, and its privacy invariant
(ids, enums and numbers only) means every (event, effects) pair goes to the flight recorder as is and a flight log
replays through `step`. That is the owner's "debug flag so you have the data" made structural.

Rejected from B: `Policy.mic: open|gated`, `ClaudeTurn.echo-tail`, `Effect mic.gate`. A's `Frame.echo` already
says it and the device is its one owner. The engine's policy shrinks to `interrupt: duck|pause|none`, word check and timings.

Rejected from A: dropping the hold on the fallback. On a backend with `interrupt: "none"` (process backend on speakers),
the engine holds `say.requested` while `user.kind === "talking"` and starts it on `utterance.ended`. No timer
(owner rejected a fixed cap). This is the PR #52 behaviour, expressed as one reducer rule instead of a poller.

## Module map

| Module | One job | From |
|---|---|---|
| `src/audio/device.ts` | The only audio port: `openAudio(purpose)`, `play(sound)`, `Frame`, `Playback`, `AudioSession` | A |
| `src/audio/mic.ts` (internal) | Mic ownership: cross-process lock, one owner per process, work-listener preemption, release after the mic is really closed | A (absorbs lock.ts, exclusive(), worklisten hand-off) |
| `src/audio/native.ts` (internal) | Client for the native worker; wire types stay here | A/B |
| `src/audio/process.ts` (internal) | rec/sox/ffmpeg in, play/afplay/say out, SIGSTOP pause, headphone detection, echo flag | A (absorbs speakers.ts, kokoro players) |
| `native/audio-worker.swift` | VoiceProcessingIO: mic out as 16 kHz s16le on stdout, play/gain/stop commands as JSON lines on stdin, ready/pos/done/error/mic-closed on fd 3. No VAD, no policy, no files | A/B |
| `src/native-build.ts` | Consent-gated swiftc build + hash for every native binary (bubble, worker) from one registry | A/B |
| `src/listen/utterances.ts` | The one frame loop: frames → Endpointer → onset/blip/ended events + utterance audio in memory | A (B's ear.ts) |
| `src/endpointer.ts` | unchanged | |
| `src/stt.ts` | Transcription (final + partial), unchanged surface | |
| `src/words.ts` | One classifier: words / filler / hang-up / empty (merges isFiller, isHangUp, cleanTranscript, realWords) | B |
| `src/speech/synthesize.ts` | Text → PCM stream (Kokoro; built-in `say -o` per sentence as fallback mid-reply) | A |
| `src/speech/replies.ts` | Stateless `speak(text): Reply` (synthesize + play + exact heard words). No queue: the engine is the only say queue; the one-shot path just awaits | A, fixed per H5 |
| `src/call/engine/{types,step}.ts` | Every call rule, pure, no imports outside itself (a test fails the build otherwise) | B |
| `src/call/session.ts` | Thin shell: call lifecycle, call.json, feeds events to `step`, runs effects, inbox delivery | B/A |
| `src/state/voice-mode.ts` | Every voice-mode file (call.json, phase, inbox, mute, levels, listening). Only TS importer of hooks/voice-files.mjs | A/B |
| `src/cues.ts` | Chime, thinking tick, other cues, all through `play()` | A/B |
| `src/flight.ts` | + `recordStep(event, effects)`; replay tool | B |
| `src/bubble.ts`, `native/call-bubble.swift` | UI only; reads state files; never touches audio | unchanged |

Deleted: `speakers.ts`, `barge-in.ts`, the three recorder loops in `audio.ts`, Kokoro's players, the call's echo gate
and per-utterance WAVs, PR #52's `waitForQuiet`/`heardWhileSaying`.

## Changes from the adversarial review 

- **H1 Unheard frames end the utterance.** The first `echo` or muted frame ends the current utterance (ended, or blip if too short), so zeroed audio never reaches whisper and `user` can't stay `talking`. `mute.changed` sets the user quiet and starts any held say.
- **H2 No self-interruption.** The native adapter flags frames `echo` until the canceller has converged (measured in PR 1). Native is chosen only for output routes on an allowlist (built-in speakers, wired); AirPlay, HDMI and Bluetooth speakers stay on the fallback until measured. The shell drops a word-check result whose text matches the reply being played. Doctor reports AEC residue.
- **H3 The word check pauses, the final decides.** Words at 700 ms pause the reply at its exact position (it goes silent, so it feels stopped). The final transcript then drops it (real words, delivered with "you interrupted after …") or resumes it (cough, filler, phantom sentence). Nothing is ever dropped on a partial.
- **H4 One partial stream per utterance.** The bubble's live words and the word check share one partial request stream; the gate no longer depends on `bubbleTakesText()`. Whisper-server concurrency is measured in PR 1.
- **H5 One say queue** (the engine). `replies.ts` is stateless.
- **H6 Riskiest part first.** See the new migration order.
- **M1** A frame-gap watchdog ends a stalled mic. The hold has no timer of its own; the recorder's 60 s sentence limit still ends any utterance. A held `say` says so in its result.
- **M2** `dispatch` drains an event queue (never re-entrant).
- **M3** `AudioSession` exposes `interrupt: "duck" | "pause" | "none"`, not backend plus duplex. Routing rules (headphones, output allowlist) live in one function in the device, not the `Purpose` table. One-shot turns stay on the process backend.
- **M4** The worker protocol is one TS module; the Node stub imports it, and a contract test runs the real worker against it. Flight allowlist entries for engine events are derived from the engine's type tables.
- **M5** Smaller engine: no `playback.position`, `phase`, `forget` or `transcribe` events/effects. Tracing a decision touches four files.
- **M6** A blip is decided from `quietMs` with the word-check result, so a clap ducks for well under a second.
- **M7** Every `Playback` settles when the worker dies; `stop()` works on a paused player; `close()` stops sound synchronously; an output route change mid-call ends native and falls back.
- **Not a goal:** this plan does not make end-of-sentence detection faster (still 1.5 s of silence). Semantic turn detection is separate, later work.

## Barge-in (native backend, speakers)

1. Worker plays the reply through the same VPIO unit, so mic frames arrive echo-cancelled (`echo: false`).
2. `utterances` emits `speech.onset` at 250 ms of voice (`BARGE_IN_MS`, as on headphones). Engine: reply speaking → `speech.duck` (gain 0.3, 10 ms ramp), word check due at `at + 700`.
3. `tick` at that time, user still talking → `words.check`. The shell asks the call's `LiveTranscript` (the bubble's partial stream, H4): the request in flight answers it, or the next frame sends one. One that can't go out within 300 ms (server cold, or busy with a final) answers null. The shell reports `words.checked { words: boolean|null, quietMs }`. `words` is the partial classified by `words.ts` (words or hang-up), false when it is two or more words of the reply playing (H2, our own echo).
4. Words → `speech.pause` at the exact position (worker `pause`). Final transcript: real words → `speech.stop` + drop queued says, delivered with `(You interrupted Claude after: …)`; anything else → `speech.restore` + `speech.resume`.
5. No words, user still talking, not quiet for `BLIP_QUIET_MS` (300) and under 2 s since the duck → check again 700 ms later. Otherwise → `speech.restore`: a clap or a cough comes back up at the first check (M6). `words: null` → no more checks; the reply stays quieter and the final decides.
6. The final transcript decides whatever happened before it: real words stop a reply that was restored, too. Once the user is quiet with no transcript out (a blip, a filler, a failed transcription), a quieter reply comes back up at once; a paused one resumes after a filler, or 2 s after it paused.
7. Talking again over a restored reply whose transcript is still out ducks it again. Ending the call stops a paused or quieter reply.

Rules as built (`src/call/engine/step.ts`, tests in `test/engine.test.mjs`):

| Event (interrupt "duck", a reply speaking) | Effects |
|---|---|
| `speech.onset`, no interruption or the reply restored | `speech.duck`, word check due in 700 ms |
| `tick` at the check, user talking | `words.check` |
| `words.checked` true | `speech.pause` |
| `words.checked` false, talking, quiet < 300 ms, < 2 s since the duck | none, check again in 700 ms |
| `words.checked` false otherwise | `speech.restore` |
| `words.checked` null | none, no more checks |
| `transcribed` words | `speech.stop`, `speech.drop` per queued say, `deliver` with `interrupted` |
| `transcribed` filler or empty: ducked / paused / restored | `speech.restore` / `speech.restore` + `speech.resume` / none |
| `speech.dropped` or `transcribe.failed`, nothing else out: ducked | `speech.restore` |
| `tick` 2 s after a pause, nothing out | `speech.restore`, `speech.resume` |
| `words.checked` with no check asked | none |

Process backend: headphones → `interrupt: "pause"` (SIGSTOP), today's behaviour. Speakers → `interrupt: "none"`, frames during playback are `echo`, says hold while the user talks.

## Migration (each PR green on its own)

0. Land PR #52 (the hold on speakers) as is; it is today's behaviour the engine must keep.
1. **Probe first** (scripts, not shipped): a protocol-true worker prototype (`scripts/probe/`), run against the real Endpointer through Node. Gates with numbers: onset-to-duck under 200 ms, AEC convergence time, echo residue on each output route, music ducking (macOS 14+ setting), Bluetooth profile, mic permission under Claude Code, whisper-server concurrency, `say -o` first-sentence latency. If a gate fails, we stop and rethink before moving any code.
2. Subtract and move, zero behaviour change, zero test edits: voice-mode files, cues home (import cycle gone), one WAV header.
3. Output port + PCM synthesis + stateless `replies`; cues through `play()`; every playback settles.
4. Input port with the process adapter + `utterances`; three loops deleted; echo/muted frames end utterances.
5. Call engine with today's policy (hold included); `barge-in.ts` and PR #52's poller folded in; e2e unchanged + engine unit tests + flight `recordStep`.
6. Native worker + shared protocol module + Node stub + contract test + consent build, opt-in `VOICE_MCP_AUDIO=native`.
7. Native default on allowlisted macOS speaker routes; `VOICE_MCP_AUDIO=process` opts out; setup recommends the worker; specs. Done (2026-11-22), after the live results below. The four process mechanism tests (mic muted while a call speaks, speakers don't pause, headphones pause, a filler resumes) stay on the process backend: the speaker two now run with the worker built and `VOICE_MCP_AUDIO=process`, and assert it never ran. Their native counterparts run against the stub's command log in `test/native-audio.test.mjs`, which no longer sets `VOICE_MCP_AUDIO`.

## Probe results (2026-11-21, MacBook Air built-in speakers and mic, macOS 27)

All gates passed: onset to duck 96 ms (tone) and 99, 84 and 99 ms on three voiced tries (3 of 3 heard), gate 200; no false onset in the first 5 s of a reply without calibration; echo residue median -100 dB, 95th percentile -69 dB, max -42.5 dB (no false onset; speech needs -48 dB, uncancelled -48.4 dB); mic permission granted to a worker spawned from Node; other-app ducking -5 dB at `min` versus about -30 dB by default; standby `say -o -f -` to the worker 452 ms to first sound versus 448 ms for today's standby `say`.

What it changes in this design:
- **Whisper serves one request at a time.** A word check queued behind a final waits for it (about 0.9 s for a long utterance). The engine treats a word check that cannot start within 300 ms as `words: null` and decides on the final, keeping the reply ducked; a second whisper server is not worth its memory yet.
- **A process recorder and the voice-processing unit never overlap.** A `rec` running across the unit's start or stop delivers audio at the wrong rate. The device fully stops one before starting the other (mid-call fallback, work listener, a second session).
- **Other-app ducking is set to `min` before the unit starts.** The default is severe and a change takes 1 to 2 s to apply.
- **Built-in speech keeps a standby.** A pre-started `say -o <file> -f -` per reply replaces today's standby `say`.
- **Worker protocol:** every command carries `seq` and is acknowledged; `play` carries its sample rate; `pause`, `resume` and `duck-others` are commands; `aec`, `agc` and `duck-others` apply while running. The Endpointer's room floor resets when `aec` toggles.
- **The native backend needs macOS 15.** The worker's lock-free rings use Swift's `Synchronization` atomics; older systems keep the process backend.
- **Protocol as built** (`src/audio/protocol.ts`, the one definition): `ready` carries the protocol version; every ack carries `status` (`ok`, `bad-command`, `unknown-id`, `busy`, `failed`) and `playedMs` when the command names a playing sound; `done` carries `playedMs`; `frames-dropped` and `route-changed` exist. `unknown-id` after `done` is normal, since a command can cross it. A route change sends `route-changed`, then `done stopped` for each sound, then `mic-closed`, and exits 0. `playedMs` counts samples taken by the render callback, so it leads the speaker by the output latency. At most eight sounds play at once.
- **The "echo until converged" flag (H2) is Node's job** in the native adapter; the worker knows nothing about convergence.
- **Built-in speech on the process backend stays direct `say`** (step 3): converting it to PCM there would slow its first sound. The native backend uses the standby `say -o <file> -f -` above.
- Not yet measured: Bluetooth speakers and AirPlay/HDMI routes (stay on the fallback per H2), a host that has never been granted mic permission.

## Live results (2026-11-22, built-in speakers, native backend)

- Barge-in on real words ducked, paused and stopped the reply.
- A cough and an "mm-hmm" ducked the reply, which then came back up and finished.
- About 47 s of reply with the user silent produced no onset: no self-interruption.
- Gate e (`say -o` first sound) at load 4 to 6: standby `say` 293 ms, native standby `say -o` 451 ms, +158 ms against a gate of 200 ms. Passed.
- Not measured: Kokoro on the native backend.

## Owner decisions (2026-11-21)

- Headphones stay on the process backend.
- Echo cancellation lowering other apps' audio during a call is accepted; set ducking to the minimum macOS allows.
- `spd-say` is dropped; Linux keeps `espeak-ng`.
