# Voice turn

Source: `src/voice.ts`, `src/server.ts`, `src/mcp.ts`, `src/texts.ts`.

A voice turn is one `speak_and_listen` call. voice-mcp speaks a line, listens for one reply, transcribes it on
the Mac, and returns the transcript to Claude. This spec covers that round trip, the MCP tools and prompts
around it, the small stdio MCP server, and the texts the model reads. For the files a turn shares with the
plugin hook and Voice Buddy, see [voice-mode.md](voice-mode.md). For calls, see [call-mode.md](call-mode.md).
Every knob named here is in [configuration.md](../configuration.md).

## The round trip

`speakAndListen` in `voice.ts` runs these steps in order.

1. It waits for a spoken update from an earlier call to finish (`finishSpeaking`). There is one speaker.
2. It stops the work listener and takes anything still waiting in the inbox (`takeInbox`). The mic belongs to
   this turn now. Words the user said while Claude worked, and that the hook has not delivered yet, become a
   note on this result (`interjectionNote`). See [voice-mode.md](voice-mode.md).
3. It clamps `listen_seconds` to between 1 and `MAX_LISTEN_SECONDS` (120). A missing or non-finite value
   becomes `DEFAULT_LISTEN_SECONDS` (30). Both live in `src/config.ts`.
4. When the turn listens, it runs `preflight` and then `prewarm` on the speech model. The model loads into the
   warm whisper server while the line plays, so it is ready when the user finishes.
5. It opens an audio session with `openAudio({ purpose: "turn" })`. If another voice session on this Mac holds
   the speaker and mic, the phase shows `waiting` until it is free. A `MicBusyError` becomes a normal failed
   result, not a thrown error. On any failure here the phase is cleared, so `waiting` never stays on screen.
6. With `listen: false` the turn becomes a spoken update (see below). Otherwise `turn` speaks, listens and
   transcribes.
7. After the turn the session closes. The recorder already stopped when the turn was decided. The mic is
   handed back once the recorder process has really exited (`session.ended`).
8. If the user answered out loud (`heard: true`), the work listener starts again once the turn's recorder is
   gone. It listens for "Claude, ..." while Claude works.

Notes are ordered with the interjection note first, then notes left over from an earlier spoken update
(`laterNotes`), then the turn's own notes. The last note is always the timing line.

### Preflight

`preflight` checks everything a turn needs before a word is spoken. It never installs anything. It looks for a
recorder (SoX or ffmpeg), a whisper binary (`whisper-cli` or `whisper-server`), and the speech model
(`ensureModel({ download: false })`). Each missing piece maps to a `SpokenError` kind: `no-recorder`,
`no-whisper`, `model-downloading` or `no-model`.

Nothing is playing or recording yet. So on a `SetupError` the user hears the error tone and one short line,
not Claude's text (`announceErrorIfMicFree`). The note from that (`errorNote`) rides on the error as
`voiceNote`, and `server.ts` appends it to the tool result. It tells Claude the user already heard the
error, so Claude explains on screen and does not repeat it aloud. The cue rules are in
[voice-cues.md](voice-cues.md).

### Speak, listen, transcribe

`turn` records each phase with `onPhase`: `speaking`, `listening`, `transcribing`. The phase goes to the phase
file and, when the client asked for progress, to an MCP progress notification. `server.ts` rewords `waiting`
as "waiting for another voice session on this Mac to finish".

- The line is cleaned up first by `prepareSpeech` (word cap `CONFIG.maxSpeakWords`, character cap
  `MAX_SPEAK_CHARS`). Its notes go on the result. See [speech-output.md](speech-output.md).
- `flightTurn` marks the turn for the flight recorder ([flight-recorder.md](flight-recorder.md)).
- After speaking, `prewarmKokoro` runs. It does nothing unless the Kokoro worker was idle-stopped or recycled,
  so the next reply is not cold.
- The start chime plays from `onListening`, which fires once the mic is really recording. The user's first word
  is never lost. Listening itself is in [listening.md](listening.md).
- When the user stops talking, the close cue (a pop) plays while whisper transcribes. If the transcript is
  empty, the pop is aborted and the no-speech cue (a low purr) plays instead, right away.

### Outcomes

The result text decides what Claude and the plugin hook do next. The hook checks only the start of the text
(`NOT_HEARD_PREFIXES` in `hooks/voice-mode-lib.mjs`), so a user who says one of these phrases out loud does
not end voice mode.

| Outcome | Result text starts with | `ok` | Notes |
|---|---|---|---|
| Pure digital silence from the mic | `The microphone returned pure digital silence` | false | `announce: "silence"`. |
| Nobody spoke within the start timeout | `(No speech detected` | true | The purr plays. |
| A sound, but whisper found no words | `(No speech detected` | true | A cough, typing, a door. |
| The user started typing | `(The user started typing` | true | `USER_TYPED`. |
| Spoken update, mic not opened | `(Speaking in the background` | true | `listen: false`. |
| Another session holds the mic | `Another voice session on this Mac` | false | From `MicBusyError`. |
| A transcript | the user's words | true | `heard: true`. |

The no-speech text names the wait as the smaller of `CONFIG.startTimeoutSeconds` (`VOICE_MCP_START_TIMEOUT_SECONDS`,
default 15) and the turn's listening limit. Both no-speech texts tell Claude to ask once more and then pause
voice mode on screen. The mic is off by then, so the user must type to carry on.

Digital silence means the recorder delivered only zeros. With SoX this usually means microphone access is
blocked (`MIC_PERMISSION_HINT`). With ffmpeg, which voice-mcp uses only when SoX is missing, ffmpeg may also
be reading a silent or wrong input device, for example after Bluetooth headphones connect. That text suggests
`brew install sox`. `resetWhichCache` runs first, so a SoX install takes effect on the next turn without a
restart. The tone and line for `announce` play only after `session.ended`, so the recorder cannot pick them
up, and only if no other session took the mic in the meantime.

Two more notes can appear on a transcript.

- Lines whisper invents from noise are dropped from the transcript and listed in a note. See
  [speech-to-text.md](speech-to-text.md).
- When listening hits the time limit while the user is still talking (`max-duration`), a note says the reply may
  be cut off. It carries the audio levels (background, voice, and the last second's level and spread in dB),
  so the end-of-speech thresholds can be tuned.

### Typing stops a turn

The voice-buddy mod writes the stop file at the user's first keystroke. `watchForTyping` polls it every
`STOP_POLL_MS` (100 ms) through `stopRequestedSince(startedAt)`. A stop aborts the turn at once, rather than
after the 15-second wait for speech. The resulting `CancelledError` becomes the `USER_TYPED` result, which
tells Claude to wait for the typed message. `flightStopSeen` records that the stop was seen. The stop file and
its session rules are in [voice-mode.md](voice-mode.md).

## Spoken updates (`listen: false`)

A spoken update ("give me a few minutes") returns almost at once, and Claude carries on working while it plays.
Before this, each update held Claude up for the whole sentence, 7 to 12 seconds (commit `7f9a34f`).

`speakInBackground` keeps the audio session until the speech ends, then closes it. It waits
`EARLY_FAILURE_MS` (300 ms) for an early failure, such as no voice installed, and throws that from the call as
before. A failure after the call returned goes in `laterNotes` and rides on the next result as
`voice-mcp note: your last spoken update wasn't heard: ...`. A Kokoro fallback note goes the same way.

The speech is not tied to the request's abort signal, because the request ends long before the sentence does.
The user typing still stops it (`watchForTyping(startedAt)` with no outer signal).

`trackSpeaking` records the playing speech, so the next turn, a call's `say`, a call start, and `voice_setup`
all wait for it (`finishSpeaking`). A finished update clears itself only if no newer one replaced it.

If the work listener was running before the update, it starts again once the speaker is quiet, so it never
hears voice-mcp's own voice. It counts from `t0`, the moment the call returned. That is when the plugin's hook
writes the session's mark. It does not restart after a failure or after the user typed.

## Notes and timing

Every tool result is one text block followed by notes, each as its own block prefixed with a blank line.
`isError` is `!ok`.

- A Kokoro fallback (`fallbackNote`) is reported once per distinct failure per server process
  (`reportedFallbacks`), not on every turn. Claude is told to mention it once and that `voice_setup` shows the
  cause.
- `timingNote` adds one compact line per turn, so "why did that feel slow?" has an answer. It shows how long
  speaking took, with Kokoro's time to first sound and whether the voice was loaded cold, then listening (and how
  long the user talked), then transcription. The tool description tells Claude to ignore it unless asked.

## The tools and prompts

`createServer` in `server.ts` registers the tools and prompts. Their descriptions come from `texts.ts`.

| Tool | What it does |
|---|---|
| `speak_and_listen` | One voice turn. Refuses during a call with `ON_CALL_USE_SAY`. |
| `call` | `start` takes the mic for a call. `end` hangs up. See [call-mode.md](call-mode.md). |
| `say` | On a call, speak and return at once. Adds a note for anything in the inbox. |
| `listen` | On a call, wait up to `wait_seconds` for the user's next words. |
| `flag` | Save the last minute of the flight recorder. See [flight-recorder.md](flight-recorder.md). |
| `voice_setup` | Check, or with consent install, what voice-mcp needs. See [setup-and-doctor.md](setup-and-doctor.md). |

Rules that span tools:

- `speak_and_listen`, `call start` and `voice_setup` run inside `exclusive`, so only one of them uses the
  audio at a time in this process.
- `listen` waits at most `MAX_LISTEN_WAIT_SECONDS` (40). The Cowork bridge drops tool calls after 60 seconds.
- `call start` says nothing. Claude greets the user once, with `say`, so the user does not hear two greetings.
- A `call end` that arrives while a `call start` still waits for the mic aborts that start (`startingCalls`).
  The start then returns `CALL_ENDED_BY_CLAUDE`.
- The first `READY` from `voice_setup` after an install speaks one short line (`READY_LINE`), once per server
  process.
- `failed` turns an error into a tool error. A `SetupError` reads `voice-mcp is not set up yet: `, and anything
  else reads `voice-mcp error: `. The hook treats both prefixes as "not heard".

The prompts are user messages a client can insert.

| Prompt | Where users find it |
|---|---|
| `setup` | Claude Code: `/mcp__voice-mcp__setup`. Other clients: the prompt picker. |
| `voice_mode` | Claude Code: `/mcp__voice-mcp__voice_mode [task]`. Claude Desktop and Cursor: the prompt picker. |
| `call` | Claude Desktop and Cursor: the prompt picker. Claude Code has `/mac-voice-mcp:call` instead. |

### Startup and shutdown

`startServer` connects stdio and logs one ready line with the model and language. When stdin is a terminal it
also says this is an MCP server and points to `setup`, `test` and `--help`. It starts the flight recorder,
which does nothing unless `VOICE_MCP_FLIGHT_RECORDER` is on. It also runs `locateModel`, which is cheap and
installs nothing. It links an existing model on disk into the cache if one exists.

Shutdown runs once, on stdin close, `SIGINT` or `SIGTERM`. It ends any call, stops the work listener, the
whisper server and Kokoro, terminates child processes (`SIGTERM`, then `SIGKILL` for any that do not exit),
cancels in-flight calls, and exits.

## The stdio MCP server

`mcp.ts` is a small MCP server over stdio. It speaks newline-delimited JSON-RPC 2.0 and implements only what
voice-mcp uses: `initialize`, `ping`, tools, prompts, progress notifications and cancellation.

It replaced `@modelcontextprotocol/sdk` at runtime (PR #29). The SDK also installs an HTTP server stack
(express, hono, cors and others) that a stdio server never runs. That was about 95 packages for two tools. The
tests still drive this server with the official SDK client, so the two stay compatible.

Protocol details:

- `PROTOCOL_VERSIONS` is newest first. `initialize` answers with the client's version when it is in the list,
  and with the newest otherwise.
- A line that is not JSON gets a `-32700` parse error with `id: null`. A batch (an array) is dispatched item by
  item.
- A message without a string `method` is a response. The server never sends requests, so it ignores
  responses.
- A message without a string or number `id` is a notification. Only `notifications/cancelled` does anything:
  it aborts the matching in-flight call. A cancelled call sends no answer, because the client expects none.
- Unknown methods get `-32601`. Bad prompt arguments get `-32602`. Any other thrown error gets `-32603`.
- Bad tool arguments, and unknown tools, come back as a tool result with `isError: true`, not a protocol
  error, so the model sees what to fix.
- Tool input schemas are listed as draft-7 JSON Schema of the input side (`z.toJSONSchema`).
- Prompt arguments are always strings in MCP. A prompt argument is required when its schema rejects
  `undefined`.
- `ToolContext.progress` exists only when the client sent a `progressToken`. Each call sends
  `notifications/progress` with a counter that starts at 1, and stops sending once the call is aborted.
- Write errors on stdout are ignored. The client has gone, and stdin's close handles shutdown.
- `close` aborts every call still running.

## The model-facing texts

`texts.ts` holds everything the model reads: the speaking rules, server instructions, tool descriptions,
prompts, and the call's short status lines.

`SPEECH_RULES` is shared by `SERVER_INSTRUCTIONS`, the `speak_and_listen` and `say` descriptions, and the
`voice_mode` and `call` prompts. Each client surfaces guidance through a different channel. Claude Desktop,
for example, ignores server instructions but always shows tool descriptions. Sharing the rules means every
client sees the same guidance, whichever channel it reads. For `say` and the call prompt, `text_to_speak` is
replaced with `text`, the name of `say`'s argument.

`SERVER_INSTRUCTIONS` must stay under 2 KB. Claude Code truncates server instructions at that size.

The call texts (`CALL_TOOL_DESCRIPTION` through `CALL_PROMPT`) serve `src/call/session.ts`. `CALL_RULES` is
what `call start` returns. `PERMISSION_NOTICE` is what a call says aloud when Claude Code shows a permission
prompt. The plugin hook asks for it through the permission file (see [voice-mode.md](voice-mode.md)).

Some result texts are matched by prefix in `hooks/voice-mode-lib.mjs` (`NOT_HEARD_PREFIXES`). Changing how one
of them starts changes when voice mode ends. Change the list in the same commit.
