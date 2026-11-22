# Audio I/O

Source: `src/audio/device.ts`, `src/audio/mic.ts`, `src/audio/process.ts`, `src/audio/native.ts`, `src/audio/protocol.ts`, `native/audio-worker.swift`.

This spec covers how voice-mcp hears and plays sound. It covers the audio port, its two backends, the mic lock, and the moments when the mic cannot hear the user. The design history and measured gates of the native backend are in [call-audio-redesign.md](call-audio-redesign.md). The settings named here are listed in [configuration.md](../configuration.md).

## The audio port

`src/audio/device.ts` is the only audio module the rest of the code imports. Everything that hears sound (a voice turn, a call, the work listener, doctor) opens an `AudioSession` with `openAudio`. Everything that plays sound (replies, cues, doctor) goes through `play()`. Which program records or plays, who owns the mic, and when the mic cannot hear the user all stay behind it. `mic.ts`, `process.ts`, `native.ts` and `protocol.ts` are internal to `src/audio/`.

### Sessions and purposes

`openAudio({ purpose })` takes one of four purposes.

- `turn` and `call` take the mic lock. A call's lock makes every other session give up at once instead of waiting.
- `worklisten` never takes the lock. It gives way to any of the others.
- `doctor` takes nothing.

`openAudio` routes first and claims the mic second, so a cancel that arrives while routing still ends the wait for the mic. `onWait` is called once if the session has to wait for another one. `signal` cancels that wait.

An `AudioSession` has these parts.

- `frames()` starts the recorder. Call it once. It ends when the session closes and throws when the mic stops on its own. `return()` stops the recorder without waiting for it to exit.
- `signal` aborts when the session closes, or when the mic is taken from it (only the work listener's mic is ever taken).
- `ended` resolves once the mic has really closed and been given back.
- `close()` closes the mic and gives it back. It is idempotent and resolves with `ended`.

A `Frame` is 30 ms of mic audio: `FRAME_BYTES` (960) of 16 kHz mono s16le. Its `echo` flag says the user cannot be heard in it, because our own reply plays on speakers (or just stopped), or the user muted the call. A consumer neither judges an `echo` frame as speech nor keeps it. This is how "half duplex" lives in data the device owns, so no consumer branches on duplex.

### When the mic cannot hear the user

Only a call marks frames `echo`. A frame is `echo` when any of these holds.

- The user muted the call. A call polls the mute file (`muteFile()` in `src/state/voice-mode.ts`) every 250 ms (`MUTE_POLL_MS`) and logs a `call.mute` flight event when it flips.
- The native worker's canceller may not have converged yet (`Worker.converging()`, the first 500 ms after the unit starts, see [Convergence](#convergence)).
- On a backend with `interrupt: "none"`, a reply is playing, or one stopped less than 300 ms ago (`ECHO_TAIL_MS`). Our own reply reaches the mic a moment after it stops.

Cues do not count as replies. A cue is too short to count as speech, and the thinking tick plays while the call listens.

### Routing

`route()` in `device.ts` is the one routing rule. It returns the session's `Interrupt`, which says what a reply can do when the user talks over it.

- `duck`: the native backend. Its sound is cancelled from the mic, so a reply can be turned down while the user talks.
- `pause`: headphones. The mic hears the user, not the reply, so a reply can pause.
- `none`: the reply's sound reaches the mic, so frames are `echo` while it plays.

Only a call plays replies while its mic is open, so every other purpose gets `none`. A call gets `duck` when all of these hold: `VOICE_MCP_AUDIO` is `native` (the default), the Mac runs macOS 15 or later, `VOICE_MCP_CALL_DUPLEX` is `auto`, no worker has failed in this process, setup has built the worker (`nativeState("audio-worker") === "built"`), and the output route is an allowlisted speaker. Otherwise a call gets `pause` when `detectDuplex` says `full`, and `none` when it says `half`. A `VOICE_MCP_CALL_DUPLEX` that names a mode keeps the call on the process backend, as do headphones.

If the worker cannot start, the session falls back from `duck` to `none` (native runs only on speakers, so `pause` never applies). `describeCallAudio()` puts the backend a call would use now into words for doctor.

### Native failures and fallback

A worker that fails to start sets `nativeBroken`, and calls stay on the process backend until the server restarts. A mic permission prompt left unanswered would otherwise stall every call by the 10 s start timeout. The failure logs an `audio.fallback` flight event with the time it took.

A running worker can end on its own, after a device change, a stalled mic, or a crash. `worker.lost` then aborts the session and logs `audio.lost`. A crash or a stall sets `nativeBroken`. A route change does not, because the worker was fine. The next session routes afresh, so it uses the process backend unless the new route is an allowlisted speaker again. The caller opens that next session.

### A recorder and the unit never overlap

A process recorder running across the voice-processing unit's start or stop records at the wrong rate (found in the probe, see [call-audio-redesign.md](call-audio-redesign.md#probe-results-2026-11-21-macbook-air-built-in-speakers-and-mic-macos-27)). So the device keeps them apart in both directions.

- `startWorker()` waits until every process recorder in `recorders` has exited before it starts the unit.
- While a worker runs or is starting (`liveWorker`, `workerStarting`), a process session's `frames()` throws `MicBusyError("A call is using the microphone.")`.

### Playing sound

`play(sound)` returns a `Playback` at once. While a native session runs, its worker plays every sound, cues included, so they are cancelled from the mic. Otherwise the process backend plays it.

A `Sound` is one of three kinds.

- `speech`: PCM at `SPEECH_RATE` (24 kHz mono s16le), one buffer per sentence, so the first sentence plays while the rest renders.
- `voice`: text for the built-in voice (macOS `say`, espeak-ng, Windows SAPI). Each backend keeps one started ahead of time. The process backend lets it play directly, which keeps its first sound quick. The native backend has `say -o` render it to PCM.
- `cue`: a short sound file and a volume.

`Playback` has this contract.

- `done` settles once the player is gone: `"finished"`, or `"stopped"` after `stop()`. It rejects when the player died or failed, or when a speech source threw (the player is then stopped at once).
- `duck(gain)`: 1 is full volume. The native backend ramps to it over 10 ms. The process backend pauses below 1 and resumes at 1, except on Windows.
- `pause()` holds the sound at its position and `resume()` goes on from there.
- `stop()` stops now, also while paused.
- All four are idempotent.
- `playedMs()` is the milliseconds played so far: wall clock minus time paused on the process backend, or what the native worker reports.

## The mic lock

`src/audio/mic.ts` owns the mic. `device.ts` calls `claim(purpose)` for each session.

### Across processes

One voice turn runs at a time across every voice-mcp on the Mac. Several Claude Code windows, Claude Desktop and Cursor all share one speaker and one microphone.

The lock is the file `mic.lock` in the cache folder, created atomically with `O_EXCL` (`openSync(file, "wx")`). It holds the owner's `pid`, its start time `since`, and `call: true` for a lock held for a whole call (`src/call/session.ts`). The owner removes it on release, and on a normal process exit mid-turn. Release removes the file only if it still names this owner.

A turn waits for a held lock, polling every 250 ms, up to `VOICE_MCP_LOCK_WAIT_SECONDS`. It then fails with a `MicBusyError` that tells Claude to tell the user on screen. A lock held for a call makes a waiter give up at once with `ON_A_CALL_ELSEWHERE`.

A lock is stale, and taken over, in these cases.

- Its owner process is dead.
- It is not a call's lock and is older than 10 minutes (`STALE_AFTER_MS`), which is longer than any real turn (speaking, up to two minutes of listening, transcribing). A call's lock is held as long as its owner lives, however long that is.
- It is still unreadable 5 s after it was last written (`UNREADABLE_GRACE_MS`). It was never going to be written.

So a crash never blocks the mic for good. A takeover never removes a fresh lock that someone else just created. It renames the file aside atomically, checks that the moved file has the inode it judged stale, and links it back if not. If a newer lock already exists, the link fails harmlessly.

If the lock cannot be used at all (`EACCES`, `EPERM`, `EROFS`, `ENOENT`, `ENOTDIR`, or the cache folder cannot be created), turns go ahead without it rather than failing.

`lockIfFree()` takes the lock without waiting. It returns null when someone else holds it, because anything we said now would be recorded and transcribed as that other session's user.

### In this process

`exclusive()` runs one turn, call start or setup at a time, because there is one speaker and one microphone.

The work listener never takes the lock, so it never holds up another window's turn. It refuses to start (`MicBusyError`) while another process holds the lock, and checks every 250 ms (`BACKGROUND_WATCH_MS`) whether one has taken it. If so, its claim is preempted. A turn or a call in the same process takes the mic from the work listener and waits until its mic is really closed before taking the lock. A claim is released only once its mic is really closed.

## The process backend

`src/audio/process.ts` runs ordinary programs.

### The recorder

`findRecorder()` picks, in order, SoX's `rec`, then `sox -d`, then ffmpeg (macOS only). `VOICE_MCP_RECORDER` can force `sox` or `ffmpeg`. `RECORDER_MISSING` tells Claude to run setup.

The recorder writes raw 16 kHz mono s16le to stdout. SoX resamples from the device rate. ffmpeg records from avfoundation device `VOICE_MCP_FFMPEG_DEVICE`. `record()` cuts its output into `FRAME_BYTES` slices from the start.

A `Recording` ends once stopped and throws when the recorder exits on its own or cannot start. `stop()` sends SIGTERM, then SIGKILL if the process has not exited after 2 s. A recorder that fails before it delivered any audio reports "Recording failed", and on macOS adds `MIC_PERMISSION_HINT`, because a denied mic permission looks like that.

### Players

| Sound | Player |
|---|---|
| `speech` | SoX `play` streaming raw PCM, which is gapless and starts with the first sentence. On macOS without SoX, one short WAV per sentence through `/usr/bin/afplay`, back to back. Otherwise a `SetupError`. |
| `voice` | The built-in voice's own program, from `builtInCommand()` in `src/speech/synthesize.ts`. |
| `cue` | `afplay -v <volume>`, with a 3 s timeout. |

A speech source that fails stops the player at once, and a player that dies ends the wait for the source.

### Pause by signal

`duck()` below 1 and `pause()` stop every process of the playback with SIGSTOP. `say` or SoX goes quiet within 200 ms, and SIGCONT resumes mid-sentence. A process started while the playback is paused is stopped at once. A stopped process cannot act on SIGTERM, so `stop()` resumes it first.

Windows has no SIGSTOP, and sending it there would kill the voice. So `pause()` does nothing on Windows, and `detectDuplex` keeps Windows calls half duplex.

### The built-in voice standby

Loading a voice takes a while (about 1.4 s for a Siri voice with `say`), and the engines read the text from stdin. So one is started early and waits, and the next reply only has to hand it the text. Measured with Siri Voice 4, the time from the text to the end of the speech, beyond the audio itself, fell from 1.4 s to 0.6 s. The standby is replaced after each reply, replaced when the voice setting changes, and stopped after `VOICE_MCP_SERVER_IDLE_MINUTES` idle. `VOICE_MCP_VOICE_STANDBY=0` turns it off.

### Headphone and speaker detection

`outputRoute()` reads the default output from `system_profiler SPAudioDataType -json` (5 s timeout) and returns one of three routes.

- `headphones` (`headphonesFromProfile`): the built-in jack's headphones (an output source that says headphone), or Bluetooth unless its name says speaker. AirPods count. A Bluetooth speaker does not.
- `speakers` (`speakersFromProfile`): the H2 allowlist of speakers whose echo the native backend may cancel. These are the Mac's own speakers or wired ones: built-in transport (the speakers and the line out), or USB whose name says speaker. AirPlay, HDMI and Bluetooth speakers are not measured yet, so they are `other`.
- `other`: anything else.

It returns null off macOS, and when the profile cannot be read. Then it logs that the call mutes the mic while Claude speaks.

`detectDuplex(output)` answers whether a call can keep the mic open while Claude speaks. Windows is always `half`. A `VOICE_MCP_CALL_DUPLEX` of `full` or `half` wins. `auto` is `full` on headphones (no echo to hear back) and `half` otherwise. The caller can pass the route it already has.

## The native backend

`src/audio/native.ts` is the Node client for the audio worker, `native/audio-worker.swift`. The worker runs one macOS voice-processing unit (`kAudioUnitSubType_VoiceProcessingIO`) that owns the mic and the speaker, so macOS cancels what it plays from what the mic hears. It has no speech detection, no whisper and no call rules. Those stay in Node. `src/native-build.ts` builds it on the user's Mac after consent. It needs macOS 15 and Swift 6, because its lock-free rings use the `Synchronization` module's atomics.

### Starting and stopping

`start()` spawns the worker with stdin, stdout and fd 3 as pipes. It resolves on `ready`. If the worker cannot start, it rejects only after the process has exited, so no recorder starts while it is still alive. The start timeout is 10 s (`START_TIMEOUT_MS`), long enough to answer a first-time mic permission prompt, mostly. After that the worker is killed.

`close()` closes stdin. The worker fades out and exits within milliseconds of that. `close()` resolves once the worker has said `mic-closed` and exited, and kills a worker that hangs for 2 s (`STOP_TIMEOUT_MS`). `frames.return()` stops reading only. The worker keeps playing until `close()`.

`lost` aborts with a `WorkerLost` when the worker ends on its own. `WorkerLost.routeChanged` is true when the input or output device changed. The worker is fine, but the route is not the one it started on. When the worker dies, every pending ack resolves null and every sound with no `done` rejects with the reason.

### Convergence

Frames count as echo for 500 ms after the unit starts (`CONVERGE_MS`), until the canceller has converged (H2). The probe heard no false onset in the first 5 s of a reply with no calibration (residue median -100 dB), so convergence there is already under a frame or two. 500 ms is a margin for other Macs and rooms that costs nothing audible, since the call's greeting plays then. Convergence is Node's job. The worker knows nothing about it.

### Playing through the worker

Speech goes to the worker in `pcm` commands of 4800 bytes (`PCM_COMMAND_BYTES`), which is 100 ms at `SPEECH_RATE`. So a long sentence never holds up a `gain` or a `stop` behind it. A cue is a `play` with its file and volume as `gain`. `duck(g)` sends `gain` with a 10 ms ramp.

Built-in speech on the native backend uses `say -o`. Each chunk (`chunkForSpeech`) is rendered to a 16-bit WAV at `SPEECH_RATE` in a temp folder, read, resampled if needed, and sent as PCM. A spare `say` is started ahead so its voice is loaded: the first one while the call starts, then the next chunk's while this one renders. A spare whose voice setting changed is replaced. Live, standby `say -o` took 451 ms to first sound against 293 ms for the process backend's standby `say`, inside the 200 ms gate (see [call-audio-redesign.md](call-audio-redesign.md#live-results-2026-11-22-built-in-speakers-native-backend)).

## The worker wire protocol

`src/audio/protocol.ts` defines the protocol once. The worker mirrors it in Swift, the Node test stub (`test/stubs/audio-worker.mjs`) imports it, and `test/audio-worker-contract.test.mjs` runs the real worker against it. A change to a message type changes all three.

| Channel | Carries |
|---|---|
| stdin | One JSON command per line, each with `seq`. The worker answers each with an `ack`. |
| stdout | Mic audio only: 16 kHz mono s16le in whole 30 ms frames (960 bytes), the same bytes `rec` gives. It never blocks. A frame the reader has no room for is dropped and counted, never queued. |
| fd 3 | One JSON event per line. The worker writes to stderr when fd 3 is not open, so it can be run by hand. |

No command or event carries words or audio a log could keep. They carry ids, enums and numbers only, apart from the PCM itself, a cue's file path (Node to worker), and a fixed `message` on `error`.

### Commands

- `play` with `rate` starts a stream of mono s16le PCM at that rate (8 to 192 kHz). `pcm` appends base64 to it, and `end` closes it. `done` follows once it has played out. `play` with `file` plays a whole audio file (anything `AVAudioFile` reads). `gain` defaults to 1 and is clamped to 0 to 2.
- `gain` ramps linearly to `value` over `rampMs` (10 by default, clamped to 0 to 1000).
- `pause` holds at the exact position, with a fade too short to hear (8 ms). `resume` and `stop` fade too, so nothing clicks.
- `aec` and `agc` turn echo cancellation and the unit's automatic gain on or off while it runs.
- `duck-others` sets how much other apps are turned down while the unit runs: `default`, `min`, `mid` or `max`. The worker starts at `min`, set before the unit starts, because the default turns other apps down hard (about -30 dB against -5 dB at `min`) and a later change takes 1 to 2 s to apply.

### Events

- `ready`: the unit runs and frames flow. `v` is the worker's `PROTOCOL_VERSION` (1), `rate` the unit's rate, `aec` whether echo cancellation is on.
- `ack`: `status` is `ok`, `bad-command`, `unknown-id`, `busy` (all eight sounds in use) or `failed` (with an OSStatus `code`). `playedMs` comes with every command that names a playing sound. A line the worker could not read gets `seq` -1 and an empty `op`. `unknown-id` is normal after `done`, because a command can cross it on the way.
- `pos`: about every 100 ms while a sound's position moves.
- `done`: exactly once per accepted `play`, with `finished` or `stopped`, also when the worker shuts down.
- `error`: fatal, with `stage` `permission`, `start` or `run`. The worker exits with code 1.
- `mic-closed`: the mic is closed and the worker is exiting.
- `route-changed`: the default input or output device changed. The worker then sends `done stopped` for each sound and `mic-closed`, and exits 0.
- `frames-dropped`: mic frames lost since the last report (at most once a second) because stdout was not read fast enough.

`playedMs` counts samples taken by the render callback, so it leads the speaker by the output latency. `parseEvent` and `parseCommand` return null for anything malformed or unknown and drop fields they do not know. Only the stub uses `parseCommand`.

## Inside the worker

### Command line

`audio-worker [--no-aec] [--no-device]`. stdin EOF or SIGTERM makes it fade out, stop the unit, send `mic-closed` and exit 0. SIGTERM is ignored (and handled as a shutdown) only from `ready` on. Until then it kills the process, so a start that hangs on the permission prompt can be ended.

`--no-device` swaps the unit for a loop that feeds what is played straight back as mic audio, 10 ms at a time, in real time. The contract test uses it, so it needs no microphone, no permission and no sound. There, SIGUSR1 acts as an output device change and SIGUSR2 stalls the mic.

### Threads

The audio callbacks take no lock and allocate nothing. They talk to the rest through single-reader single-writer rings (`Ring`) and atomics. Everything else (commands, events, resampling, the stdout writes) runs on one serial queue, `control`, which also ticks every 5 ms. stdin is read on its own thread, which hands each line to `control`.

Eight `Voice` slots exist from the start, so the render callback never sees one appear. A voice's `phase` passes ownership. Only the control queue sets `active`, after which the render callback owns the voice's render state. The render callback sets `finished` or `stopped`, and then never touches the voice again. The control queue sends `done` and frees the slot.

The render callback reads a voice's `drained` flag before its ring, so "drained and empty" cannot miss samples written in between. A fade out takes only the samples the fade needs, so a pause holds the exact position. It avoids `UnsafeMutableAudioBufferListPointer`, whose generic metadata is instantiated under a lock on the first call.

### The unit

The worker asks for mic permission if it was never decided, and fails with `error permission` if it is not granted. It then tries the unit at 48, 24 and 16 kHz, in that order. The mic and speaker sides use the same 32-bit float mono format. With different formats the unit fails with -10875.

The unit is bound to the devices it started on. When the default input or output changes, the worker sends `route-changed` and stops, and Node falls back. Older Macs keep one built-in output device and switch its data source when headphones go in, so the worker watches that source too.

### The mic

Mic samples are resampled to 16 kHz s16le on the control queue and written to stdout, which is non-blocking. When stdout is full, whole waiting frames are dropped and counted. If the reader already has part of a frame, it must get the rest, so only the frames behind it go. If the reader is gone, the worker stops writing and waits for stdin EOF. If mic callbacks stop for 2 s, the worker sends `error run` ("the microphone stopped delivering audio") and exits 1. A failing mic does not tick, so this stall check also ends the worker on a mic error.
