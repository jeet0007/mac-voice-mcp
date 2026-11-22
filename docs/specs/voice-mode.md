# Voice mode

Source: `src/state/voice-mode.ts`, `src/worklisten.ts`. Read alongside `hooks/voice-files.mjs` and
`hooks/voice-mode-lib.mjs`.

Voice mode keeps a conversation in voice. After the user answers out loud, the Claude Code plugin's hook sends
Claude back to reply with `speak_and_listen` instead of a text message, and the MCP server keeps the mic open
while Claude works so the user can say "Claude, ...". This spec covers the voice-mode state folder that the
server, the hook and Voice Buddy share, and the work listener. The voice turn itself is in
[voice-turn.md](voice-turn.md). Knobs are in [configuration.md](../configuration.md).

## The state folder

Everything lives in `<cache>/voice-mode/`. `cacheRoot` resolves `<cache>` from `VOICE_MCP_CACHE_DIR`, else
`$XDG_CACHE_HOME/mac-voice-mcp`, else `~/.cache/mac-voice-mcp`.

The shared names are defined once, in `hooks/voice-files.mjs`. It is plain Node with no build step, because an
installed plugin has no `dist/`. The hook imports it as is. The server imports it as `../hooks/voice-files.mjs`,
which ships in the npm package beside `dist/`. Only two TypeScript modules import it, `src/state/voice-mode.ts`
and `src/config.ts`. `config.ts` needs `cacheRoot` before `voice-mode.ts` can load. Voice Buddy
(`plugins/voice-buddy`) and `hooks/after-tool.sh` cannot import it. The tests pin their copies of the names.

| File | Written by | Read by | Format and meaning |
|---|---|---|---|
| `listening.state` | hook | server | `{"session", "at"}`. This session is in voice mode, marked at `at` ms. |
| `stop` | Voice Buddy | server | `{"at", "session"}`. The user started typing at `at` ms. |
| `inbox/*.json` | server | hook, server | `{"text", "at"}`. Something the user said to Claude while it worked. |
| `phase.json` | server | Voice Buddy, call bubble | `{"phase", "at"}`. What the voice turn is doing now. |
| `call.json` | server, hook | server, hook, Voice Buddy, call bubble | Who is on a call, and which session it belongs to. |
| `mute` | call bubble | server | Present while the call is muted. The mic hears nothing. |
| `levels` | server | call bubble | `<dB> <threshold dB>`. The mic level during a call, for the bubble's glow. |
| `permission` | hook | server | `{"at"}`. Claude Code shows a permission prompt during a call. |
| `<session>.json` | hook | hook | `{"on", "at", "nudged"}`. The hook's own per-session state. |

The call files are covered in [call-mode.md](call-mode.md) and [call-bubble.md](call-bubble.md). This spec
covers the rest.

### The stop file

Voice Buddy writes `stop` at the user's first keystroke. The voice turn running now stops speaking and
listening at once, and so does the work listener.

`stopRequestedSince(since)` decides whether a stop counts.

- A stop older than `since` does not count.
- A stop names the session that typed. Once the server knows its own session (`setOwnSession`), another
  session's stop is ignored.
- A stop without a session id (an older plugin), or a stop that arrives before the server knows its session,
  counts.

The server learns its session from the hook's mark. The work listener calls `setOwnSession` with the session in
`listening.state` once it confirms voice mode.

### The phase file

`showPhase` writes `phase.json` with `speaking`, `listening`, `transcribing` or `waiting`, and removes it when
no turn is running. Voice Buddy shows it in its band above Claude Code's prompt, and the call bubble and any
display of your own can read it. There is one file for the whole Mac, because there is one voice turn at a
time. `VOICE_MCP_PHASE_FILE=0` turns it off. Writing is best effort. The band is optional, so a write error
is ignored, and a display that cannot read the file shows nothing.

### The inbox

The work listener leaves what the user said in `inbox/`, one file per message (`addToInbox`).

- What the user said is private. The folder is `0700` and each file is `0600`. The folder mode is set again on
  every write, which also fixes a folder an older version created with looser permissions.
- The file name is `<ms>-<random>.json`, made by the server and never taken from the text. The text is only
  ever read back as a JSON string. The file is created with `wx`, so it never overwrites another.
- Text longer than `INBOX_MAX_CHARS` (1000) is cut and ends in an ellipsis. A 30-second interjection is about
  100 words, so the cap only cuts whisper running on.

`takeInbox` drains the inbox oldest first and deletes what it takes. The server and every session's hook drain
the same folder. Each entry is claimed by renaming it to `<name>.<pid>.taken` first. Only one rename wins, so
no message is delivered twice. Entries older than `INBOX_MAX_AGE_MS` (15 minutes) are stale and dropped.

Two readers hand the words to Claude.

- The hook, after any tool call by the main Claude (not a subagent, whose tool calls carry `agent_id`), or when
  Claude tries to stop. It takes the inbox only if this session holds `listening.state` or is on the call.
- The next voice turn, or a call's `say`, through `interjectionNote`. This catches words the hook has not
  delivered yet.

An entry with empty text means the user said only the name ("Claude?"). Both readers phrase it as "only your
name: they want to talk".

## The hook

`hooks/voice-mode.mjs` runs `handle` from `hooks/voice-mode-lib.mjs` on each Claude Code hook event.

| Event | What the hook does |
|---|---|
| `PostToolUse(speak_and_listen)`, user heard | Sets voice mode on, and writes `listening.state` for this session. |
| `PostToolUse(speak_and_listen)`, `listen: false` while this session listens | Clears voice mode, rewrites `listening.state` so the work listener keeps going. |
| `PostToolUse(speak_and_listen)`, otherwise | Clears voice mode and this session's `listening.state`. |
| `PostToolUseFailure(speak_and_listen)` | Clears both. The call failed (not set up, mic blocked, busy). |
| `PostToolUse(call)`, `start` succeeded | Clears both, and adds this session to `call.json` (write then rename). |
| `PostToolUse`, any other tool | Hands over the inbox as added context. |
| `UserPromptSubmit` | Clears both. The user is back at the keyboard. |
| `Stop` | Hands over the inbox first. Otherwise sends Claude back to `speak_and_listen` once per spoken answer. |
| `Notification(permission_prompt)` on a call | Writes `permission`, so the call says `PERMISSION_NOTICE` aloud. |
| `SessionEnd` | Clears both, and removes `call.json` if this session is on the call, which ends it. |

"User heard" means the result's first text does not start with one of `NOT_HEARD_PREFIXES`. Only the start is
checked, so a user who says one of those phrases does not end voice mode. The prefixes are listed in
[voice-turn.md](voice-turn.md#outcomes).

The `Stop` nudge cannot loop. It fires at most once per spoken answer (`nudged`), not when `stop_hook_active`
is set, and not once the state is 30 minutes old (`EXPIRE_MS`). When the hook lets Claude stop, it also removes
`listening.state`. Claude is done working, so nothing said now could reach it, and the mic closes.

`VOICE_MCP_STAY_IN_VOICE=0` in Claude Code's environment turns the nudge off. The work listener and the inbox
still work.

## The work listener

The work listener lets the user talk to Claude while it works (PR #18). After a voice turn in which the user
answered, the mic stays open. Anything said that starts with Claude's name ("Claude, use the other branch") is
transcribed on this Mac and left in the inbox. Everything else is transcribed, checked for the name, and
dropped. Nothing is kept.

### When it runs

It runs only while the hook says this session is in voice mode. The hook writes `listening.state` right after
each voice turn and removes it when the user types. Apps without the hook, such as Claude Desktop and Cursor,
never get an open mic.

`workListener.start(turnEnd)` does nothing when `VOICE_MCP_LISTEN_WHILE_WORKING=0`, when it already runs, or
when there is no recorder. It then waits for the hook to confirm.

- Confirmation is a `listening.state` mark from 2 seconds before `turnEnd` to `CONFIRM_MS` after it.
  `CONFIRM_MS` is `VOICE_MCP_WORK_LISTEN_CONFIRM_MS`, default 10,000 ms, at least 200 ms. The listener polls
  every 200 ms.
- No mark in that window means there is no plugin hook, or voice mode ended right away. The listener gives up.
- A mark later than the window comes from another session's turn. That session takes over, and this listener
  stops.

It stops when any of these happens.

- A voice turn starts. `speakAndListen` and `call start` stop it first, and wait until the mic is free.
- The user types (a stop at or after `turnEnd`).
- `listening.state` no longer holds this turn's mark. Voice mode ended, Claude finished, or another session took
  over.
- `VOICE_MCP_WORK_LISTEN_MINUTES` (default 10) pass without a voice turn.
- The server shuts down.

A spoken update (`listen: false`) pauses it and starts it again once the speaker is quiet. See
[voice-turn.md](voice-turn.md#spoken-updates-listen-false).

### The loop

Each round opens an audio session (`purpose: "worklisten"`) and listens for one utterance of up to 30 seconds.
If another process holds the mic for a voice turn (`MicBusyError`), it waits a second and tries again, so it
never competes with a turn. A watch timer checks the stop conditions every `WATCH_MS` (250 ms). The mic closes
right away when the user types or voice mode ends, not only after the next 15-second wait. Another session
taking the mic aborts the session's own signal.

The session closes after each utterance. There is one recorder at a time, so the next round, or a voice turn,
opens the mic again. Audio with no speech, or digital silence, is skipped. Speech is transcribed from memory
with the model already on disk (`ensureModel({ download: false })`).

When `parseInterjection` finds the name, the rest of the text goes to the inbox and a soft "got it" chime
plays.

### Recognising the name

`parseInterjection` returns the words after Claude's name, `""` when the speech is only the name, and `null`
when it is not addressed to Claude. Only speech that starts with the name counts, so talk in the room, on a call
or in a video is ignored.

- An optional lead-in comes first: hey, hi, okay, ok, so, um, uh or oh, with an optional comma or full stop.
- The name matches whisper's usual spellings: claude, claud, clyde, klaud and clod, as whole words.
- "cloud" counts only with punctuation after it ("Cloud, ..."), because "Cloud deployment failed" is ordinary
  talk.
