# Setup and doctor

Source: `src/setup.ts`, `src/model.ts`, `src/native-build.ts`, `src/doctor.ts`, `src/proc.ts`, `src/config.ts`, `src/index.ts`

Setup gets a Mac from nothing to a working voice turn without surprising the user. Doctor then proves that the
turn works, with numbers instead of by ear. Every setting named here is described in
[Configuration](../configuration.md). This spec does not repeat the table.

## Setup asks before it installs

`voice_setup` and the `setup` command both call `runSetupFlow`. A plain call only checks. It reports each
item as ok, missing, optional or installing, and ends with a `Next:` line that tells Claude what to ask the
user. Nothing changes on disk until the user agrees and Claude calls again with a flag.

- `install=true` installs the missing Homebrew formulae, downloads the speech model and the silence filter, and
  builds the audio worker.
- `kokoro=true` installs the optional Kokoro voice.
- `bubble=true` builds the call bubble.

The terminal forms are `setup --install` (or `-y`), `setup --kokoro` and `setup --bubble`. A plain `setup` in
an interactive terminal prints the checklist and asks `Install the missing pieces now? [Y/n]` when the report
says to ask the user.

With `install=true`, setup also installs the optional formulae it recommends, because the user agreed to
install. Today that means SoX when only ffmpeg is there and `VOICE_MCP_RECORDER` is `auto`. ffmpeg works, but
the turn-taking is tuned on SoX, and SoX is more reliable with Bluetooth headsets and other audio devices.

A native binary that the user already built, and whose source has since changed, rebuilds without asking
again. The user opted in once. See [Native binaries are built on the Mac](#native-binaries-are-built-on-the-mac).

The setup is READY when every check is ok or optional. After an `install=true` run in a server process, the
first READY report sets `announceReady`, and the server says the ready line once per process. It does so only
on macOS with `VOICE_MCP_SPOKEN_ERRORS` on. See [Voice cues](voice-cues.md).

## Installs run in the background

An MCP tool call must not hang while `brew install whisper-cpp` runs, so each install is a background job.
Jobs live at module level and outlive the tool call that started them. One `voice_setup` call waits at most
40 s (`INSTALL_WAIT_MS`) for running jobs. It sends a progress line every 5 s through `onProgress`, which the
server turns into MCP progress notifications. If a job is still running after that, the report says
INSTALLING and tells Claude to call `voice_setup` again in about a minute. The next call picks up the
result. Each finished job's message appears once, under "What was done".

`brew install` runs with a 30-minute timeout and with `HOMEBREW_NO_AUTO_UPDATE`, `HOMEBREW_NO_ENV_HINTS`,
`HOMEBREW_NO_INSTALL_CLEANUP` and `NONINTERACTIVE` set to `1`. After every job, and at the start of every setup
run, setup clears the `which` cache, so a program that was installed meanwhile is found. That includes one the
user installed in a terminal. The terminal `setup` command keeps calling `runSetupFlow` until no job is
running, because a terminal can wait.

When the silence filter finishes downloading, setup stops the warm `whisper-server`. The next transcription
starts it again with the filter on.

Setup finds Homebrew on `PATH`, then at `/opt/homebrew/bin/brew` and `/usr/local/bin/brew`. When
`VOICE_MCP_EXTRA_PATH` is set at all, setup looks only on `PATH`, so the tests run isolated from the machine's
Homebrew. Homebrew itself needs the user's password, so setup never installs it. The report links
[brew.sh](https://brew.sh) instead.

## The speech model is found before it is downloaded

A whisper.cpp model is 75 MB to 3 GB, and many developers already have one. `locateModel` looks in this order
and never downloads:

1. `VOICE_MCP_WHISPER_MODEL_PATH`. A path that does not exist is a `SetupError`.
2. The cache, `<models dir>/ggml-<name>.bin`, as a real file or as a symlink from an earlier run.
3. The same file name elsewhere on this Mac. When it finds one, it symlinks the file into the cache, so later
   lookups take one `stat`. If the symlink fails, it uses the file in place.

Step 3 checks `VOICE_MCP_MODEL_SEARCH_PATHS` first. Then it checks Homebrew's `share/whisper-cpp` folders,
`~/.cache/claude-voice-mcp/models` (this project's cache before the rename), the whisper caches under
`~/.cache` and `~/.local/share`, `~/Library/Application Support/whisper.cpp`, and `whisper.cpp/models` in the
usual code folders under the home folder. Last, on macOS, it asks Spotlight (`mdfind -name`, 4 s timeout) and
skips hits inside our own models folder.

A file counts as a model only if it is at least 1 MB and starts with the ggml magic `0x67676d6c` (the bytes
"ggml", read little-endian). `isGgmlModel` opens the file once and reads the size and the header from the same
open file, so the two cannot come from different files. A dangling symlink or a corrupt file in the cache is
deleted before the search. The model name must match `[A-Za-z0-9._-]+`, because it becomes part of a path.

The download is step 4. Only `ensureModel({ download: true })` starts it, and only setup calls that, after
consent. Every other caller gets a `SetupError` that tells Claude to call `voice_setup`. Concurrent callers
share one download. It streams from `VOICE_MCP_MODEL_BASE_URL` (Hugging Face by default) to
`<file>.<pid>.part`, logs progress every 10%, checks the result is a ggml model, then renames it into place.
A failed download deletes the part file. `MODEL_SIZES_MB` holds the approximate sizes that the report shows
before the download.

## The silence filter is checked against its hash

The silence filter is Silero VAD, `ggml-silero-v5.1.2.bin` (885,098 bytes). whisper then skips stretches with
no speech instead of inventing words there ([#62](https://github.com/jeet0007/mac-voice-mcp/issues/62)).
[Configuration](../configuration.md#the-silence-filter) describes what it fixes and the measurements behind it.

`downloadVadModel` fetches the file into memory and compares its SHA-256 with `VAD_MODEL.sha256` before it
writes anything. It removes any old temp file, writes the new one with the `wx` flag, so it never writes
through a symlink that someone planted at the temp name, and then renames it into the models folder. A mirror
set with `VOICE_MCP_MODEL_BASE_URL` serves this file too.

`locateVadModel` accepts the file only at its exact size. A truncated or replaced file makes whisper abort,
so setup offers the download again until a good copy replaces it. The check reports the filter as optional
when the installed `whisper-cli` is too old to list `--vad`.

## Native binaries are built on the Mac

Every native binary this package runs is compiled on the user's Mac from `native/<name>.swift` with their own
`swiftc`, after they agree. Nothing native is downloaded. `NATIVE` in `native-build.ts` lists the binaries,
`call-bubble` ([Call bubble](call-bubble.md)) and `audio-worker` ([Audio](audio.md)).

`<cache>/bin/<name>.hash` holds the SHA-256 of the source that the binary came from. The hash file is also
the opt-in record, so `nativeState` reads three states from it:

- `absent`: no hash file. The user never asked for this binary, and setup only offers it.
- `stale`: a hash that differs from the current source, or a missing binary. The user opted in and a new
  version changed the source, so setup rebuilds once without asking.
- `built`: the hash matches and the binary exists.

`/usr/bin/swiftc` is a shim that opens an install dialog when the Command Line Tools are missing. So
`findSwiftc` treats it as absent unless `xcode-select -p` succeeds. A build runs `swiftc -O` with a 5-minute
timeout. It takes about 10 s. It writes to `<bin>.<pid>.tmp` and renames the result into place, so a process
that starts during the build never runs half a file. The hash is written after the rename. Concurrent calls
for one binary share one build.

The audio worker needs macOS 15 or later, which is Darwin 24 (`IS_MACOS_15`). It uses Swift's Synchronization
atomics. Setup shows it only with `VOICE_MCP_AUDIO` set to `native`, and builds it with `install=true`. The
call bubble has its own opt-in, `bubble=true`.

## Doctor answers "does it work" with numbers

`doctor` runs the checks in order. Each one ends in PASS, WARN, FAIL or SKIP against fixed limits.

1. **Setup.** `runSetupFlow` with no flags. If setup is not READY, doctor reports FAIL and stops.
2. **Speech to text.** The voice speaks `DOCTOR_SENTENCE` into a file, and whisper transcribes it twice. The
   first run is cold. The second, with the model loaded, gives the warm time and the graded transcript. This
   tests the voice and the transcriber without the room.
3. **Speaker to mic.** The same sentence plays live through the speakers while the mic records. Doctor then
   transcribes the recording. This tests the real hardware path. It runs only on macOS, and
   `--no-loopback` skips it.

When the voice is Kokoro, doctor also synthesizes the sentence a second time with the model loaded. The time
to the first sound is how long a normal turn waits. That check passes at 1500 ms or less and warns up to
3000 ms (`FIRST_SOUND_MS`).

`LIMITS` grades word error rate. A score at or under the first number passes, at or under the second warns,
and anything above fails.

| Check | PASS | WARN | Why |
|---|---|---|---|
| Speech to text (`file`) | 10% | 25% | Clean synthetic speech straight into whisper should be near perfect. |
| Speaker to mic (`loopback`) | 30% | 50% | Through the air, room noise and a laptop mic make it harder. |

The loopback recording lasts 1.5 s longer than the spoken file. Playback starts 300 ms after the first mic
frame arrives, so the recording has the whole sentence. The live sentence uses the full-quality voice, the way
`speak_and_listen` speaks, not the 16 kHz test file. Doctor keeps every frame, including frames that the audio
port flags as `echo`, because this check is meant to hear our own speech. If the recorder stops early, doctor
uses what it already heard. A recording that is all zeros fails with the microphone permission hint. A peak
under -50 dB warns, which is expected with headphones.

Doctor writes the report as JSON to `<cache>/doctor/doctor-<date>.json`, so runs on different Macs and audio
setups (headphones, Bluetooth, external mics) can be compared. The report includes the version, the platform,
the default input and output devices from `system_profiler`, the voice, the recorder, the call audio path, the
speech-to-text setup and the model. It notes the flight recorder when it is on. `settings.set` lists every
`VOICE_MCP_*` variable that is set, and `settings.resolved` the value each setting resolved to, defaults included.
The setup checklist (the `setup` command and `voice_setup`) ends with the same `set` list on one line. Run
inside a session, `voice_setup` shows the variables the MCP client passed to the server, which a terminal doesn't see.
If the report file cannot be
written, doctor still prints the results. `doctor --json` also prints the report to stdout. The command exits
with 0 when no check failed, and with 1 otherwise.

## Child processes

`proc.ts` runs every program voice-mcp starts.

- `which` resolves a program on `PATH` and caches the answer. It checks an absolute path as is. On Windows it
  tries each `PATHEXT` extension. `resetWhichCache` must run after `brew install` adds programs.
- `run` returns the exit code, stdout, stderr and whether it timed out. stdin is closed unless the caller
  passes `input`. A timeout or an abort sends SIGTERM (or `killSignal`), then SIGKILL 2 s later. An abort
  rejects with `CancelledError`. An EPIPE on stdin, when the program exits before reading it all, is ignored.
- `startWaiting` starts a program before its input exists, so it can load what it needs, such as a voice. It
  starts work the moment `send()` delivers the input. The built-in voice standby uses it.
- `activeChildren` holds every child that is running. On shutdown, `terminateChildren` sends SIGTERM to each,
  waits up to 400 ms, then sends SIGKILL to the ones still running. It finishes before the server exits, so a
  slow recorder cannot keep the mic.
- `SetupError` is an error that the user fixes by installing or configuring something. Its message says how.

## Configuration and logging

`config.ts` reads every `VOICE_MCP_*` variable once, at startup, into `CONFIG`. A number that is blank or not a
number falls back to its default (`envNum`). A switch is off for `0`, `false`, `no` or `off`, in any case, and
on for anything else (`envBool`). Several numbers are clamped to a range. [Configuration](../configuration.md)
lists each default and range.

stdout carries the MCP protocol, so `log` and `debug` write to stderr with a `[voice-mcp]` prefix.

GUI apps such as Claude Desktop and Cursor start MCP servers with a short `PATH` that misses Homebrew. So, on
macOS and Linux, `config.ts` adds the Homebrew folders to the end of `PATH` when it loads. Then `rec`,
`ffmpeg`, `brew` and the whisper.cpp programs are found with no extra settings. `VOICE_MCP_EXTRA_PATH` replaces
the list.

## Entry point

`index.ts` is the `mac-voice-mcp` and `voice-mcp` command. With no argument, or `serve`, it starts the MCP
server on stdio. `--help` lists the other commands. They are `setup`, `doctor`, `test ["text"]`,
`flag ["note"]`, `flight status|purge` and `--version`. An unknown command prints the help and exits with 2.
The README lists the MCP tools, and [Development](../development.md) has the module table.

`test` speaks one line, listens for one turn for at most `VOICE_MCP_TEST_SECONDS`, and prints the transcript
to stdout. It then stops the warm `whisper-server` and the Kokoro worker, so the command exits.

The development module table does not list these modules:

- `proc.ts`: the child-process helpers above.
- `doctor.ts`: the self-check above.
- `wer.ts`: word error rate, pure.
- `texts.ts`: everything the model reads (rules, instructions, prompts).
- `bubble.ts`: starts and stops the call bubble with a call.
