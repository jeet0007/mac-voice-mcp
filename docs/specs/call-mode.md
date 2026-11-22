# Call mode (0.8.0)

Status: planned · Owner: Jeet · Target: 0.8.0 (Mac, headphones first); speakers 0.9.0; Windows after.

Source: `src/call/engine/types.ts`, `src/call/engine/step.ts`, `src/call/engine/words.ts`, `src/call/session.ts`.

## Goal

> "I start a call. Claude listens, works and answers out loud, like we're on a phone call, until I hang up."

Today voice-mcp is a walkie-talkie: Claude calls `speak_and_listen`, speaks, then opens the mic, then waits.
Only one side is on at a time and Claude only hears you when it asks. A call keeps the line open: you can
talk while Claude works, while it's idle, and (on headphones) while it speaks.

Claude's thinking stays turn by turn (a person on a call also thinks, then speaks); what changes is the audio
and when your words reach Claude.

## Principles (keep)

- **On-device:** whisper.cpp for speech-to-text, `say` or Kokoro for the voice. No cloud audio.
- **Inside the user's own session:** no `claude -p` wrapper (that bills a separate API credit), normal
  permission prompts, subscription billing. Claude Code gets the full experience; Claude Desktop and Cursor
  get a reduced one (see Delivery).
- **Dependencies:** runtime stays at zod. Anything heavy (Silero VAD runtime, native helpers) installs on
  consent into the cache, like kokoro-js.
- **Privacy:** the user's speech is transcribed on the Mac, handed to Claude, and deleted. Nothing is kept.
- **Measured:** every behaviour below has a number in Acceptance, checked with stubs in CI and with
  `npm run test:local` on a real Mac.

## Non-goals (v1)

Echo cancellation on speakers (0.9.0: Voice Processing I/O helper), Windows (after 0.9.0), speaking while
Claude is still writing (MCP only sees finished tool calls), telephony, cloud speech.

## What already exists (reuse)

| Piece | Where | Use in call mode |
|---|---|---|
| Recorder + turn-taking (energy VAD, end silence) | `audio/device.ts`, `listen/utterances.ts`, `endpointer.ts` | Segment the open mic into utterances |
| Listen while Claude works, inbox, hook delivery | `worklisten.ts`, `hooks/voice-mode-lib.mjs` | Becomes the call's mic engine, without the "Claude, …" wake word |
| Warm whisper-server | `stt.ts` | Transcribe each utterance |
| Kokoro streaming playback, background speech | `kokoro.ts`, `voice.ts` | `say`, pause/resume for barge-in |
| Stop file (typing interrupts) | `state/voice-mode.ts` | Not on a call: typing doesn't cut Claude off (a typo would) |
| Mic lock across windows | `audio/mic.ts` | Held for the whole call |
| Phase file + Voice Buddy | `state/voice-mode.ts`, `plugins/voice-buddy` | Show "on a call" |

## Design

### Call lifecycle

- **Start:** `/mac-voice-mcp:call` (Claude Code skill) or the `call` MCP prompt (Desktop/Cursor). Claude calls
  `call { action: "start" }`; the server takes the mic lock, starts the mic engine, writes
  `voice-mode/call.json` `{ pid, startedAt, duplex }` (the plugin hook adds `session`), and says nothing aloud. Claude's `CALL_RULES` tell it to greet once, in a few words, with `say`, then `listen`; the server's own greeting was dropped so the user doesn't hear two.
- **During:** the mic stays open. Silence never ends the call.
- **End:** the user says a hang-up phrase ("hang up", "bye Claude", "end the call"), types `/mac-voice-mcp:hangup`,
  or Claude calls `call { action: "end" }`. Also ends on session end, or after `VOICE_MCP_CALL_IDLE_MINUTES`
  (default 30) with nobody speaking. Ending stops the recorder within 1 s, releases the lock and empties the
  inbox. Nothing is spoken. Claude notes the end on screen.
- **One call per Mac:** another window's `speak_and_listen` returns "on a call in another window".

### Tools (MCP)

| Tool | Behaviour |
|---|---|
| `call` `{ action: "start" \| "end" }` | Start or end the call; returns call rules for Claude |
| `say` `{ text }` | Queue speech and return at once; result includes anything the user said meanwhile |
| `listen` `{ wait_seconds? = 40 }` | Return the next utterance(s), immediately if queued; on timeout returns "(still on the call, nothing said)" so Claude calls it again. 40 s keeps the Cowork bridge (60 s) safe |

`speak_and_listen` stays for normal voice mode. Open question: fold `say`/`listen` into it instead (fewer
tools in context) — decide in Phase 1 review.

### Mic engine

One recorder for the whole call → endpointer splits utterances (end silence `VOICE_MCP_END_SILENCE_MS`) →
whisper → queue. Hang-up phrases are matched on the transcript in the server (deterministic, not by Claude).
Empty or noise-only transcripts are dropped. Queue entries are deleted once delivered.

### Echo policy (v1)

`VOICE_MCP_CALL_DUPLEX = auto | full | half` (default auto).

- **half (speakers):** mic is gated while Claude speaks (what claude-call calls an echo gate); the call stays open. A reply that comes while the user is mid-sentence first waits for them to finish their sentence (no time limit; the recorder ends a sentence within a minute), so the gate never cuts them off.
- **full (headphones):** mic stays open while Claude speaks; barge-in enabled.
- **auto:** headphones detected at call start → full, else half. macOS: default output device transport and
  data source (built-in "hdpn" = headphones; Bluetooth = headphones unless the name says speaker). First
  version may read `system_profiler SPAudioDataType -json` once per call; replace with the 0.9.0 helper.

### Barge-in (full duplex only)

Speech for ≥ 250 ms while Claude speaks → **pause** playback (Kokoro: stop feeding `play` / SIGSTOP; `say`:
stop and remember the sentence). Transcribe it:

- real words (≥ 2 words, or one that isn't a filler like "mm", "uh-huh", "okay") → drop the rest of the
  reply and deliver: "(You interrupted Claude after: '…') <what you said>";
- nothing real within 2 s → resume (Kokoro from the paused chunk; `say` from the remembered sentence).

Thresholds follow Pipecat (0.2 s) and LiveKit (0.5 s, resume after 2 s); 150 ms is too aggressive.
Optional later: Silero VAD when onnxruntime is already in the Kokoro cache.

### Delivery: getting the user's words to Claude

| When | Route |
|---|---|
| Claude working (mid-turn) | Existing PostToolUse `additionalContext` from the inbox (also `say` results) |
| Claude idle (Claude Code with Voice Buddy) | **Voice Buddy's mod** submits the utterance with `$.prompt.submit({ text, asUser: true })` (Phase 0 route B: 20/20, turn starts in 0.14 s) |
| Claude idle (no Voice Buddy, Desktop, Cursor) | Claude keeps calling `listen` (call rules say: always end a turn with `listen`) |

Channels are the purpose-built route but need `--dangerously-load-development-channels` during the research
preview, so they're an opt-in extra, not the default.

### No dead air

After delivering an utterance, play a soft tick every ~1.5 s until Claude's next `say` or 10 s pass
(off by default; `VOICE_MCP_CALL_THINKING_SOUND=1` turns it on). Permission prompts: a Notification hook says "Claude needs
your OK on screen" so the call doesn't silently stall.

### Voice Buddy

New mood "on a call" (with duration) for the calling window; speaking/listening colours as today.

## Engine

Every rule of a call lives in one pure function, `step(state, event)` in `src/call/engine/step.ts`. It
returns the next state and a list of effects. The engine reads no clock, plays no audio and does no I/O.
The engine directory imports nothing outside itself, and `test/engine.test.mjs` fails if it does or if it
reads the clock. The reasons for this shape, and the barge-in rules on the native backend as a table, are in
[the call audio redesign](call-audio-redesign.md#synthesis-decision). This section covers the rest.

### Privacy and ids

No state, event or effect field carries text or audio. Fields hold only ids, numbers, booleans and the
string enums in `types.ts`. The shell keeps the words. A `SayId` names one `say` and the shell holds its
text. An `UtteranceId` names one thing the user said and the shell holds its transcript. Because nothing
private is in them, the shell sends every (event, effects) pair to the flight recorder as it is
(`recordStep`, see [the flight recorder](flight-recorder.md)), and a flight log replays through `step`.

The flight recorder's allowlist is built from `EVENT_STRINGS` and `EFFECT_STRINGS`. They list every event
and effect type with the values each string field may take. The `StringTable` type makes a missing variant
or a missing string field a compile error, so the allowlist cannot fall behind the types.

### Policy

The shell fixes a `Policy` at call start.

- `interrupt` says what talking over a reply does. It comes from the audio session
  ([audio](audio.md)).
  - `"duck"` (native backend, speakers): the reply goes quieter. Words in what the user has said so far
    pause it, and the final transcript decides whether it stops.
  - `"pause"` (headphones): the reply pauses at once, and the transcript decides.
  - `"none"` (process backend, speakers): the mic cannot hear the user while a reply plays, so a reply waits
    for the user to finish their sentence.
- `thinkingTick`: tick while Claude thinks (`VOICE_MCP_CALL_THINKING_SOUND`).
- `idleMs`: the call ends after this long without a word either way (`VOICE_MCP_CALL_IDLE_MINUTES`).

Knobs and defaults are in [configuration](../configuration.md).

### Timings

| Constant | Value | Meaning |
|---|---|---|
| `GIVE_UP_MS` | 2000 ms | After the user talks over Claude, nothing real said within this long resumes the reply. LiveKit's 2 s. |
| `WORD_CHECK_MS` | 700 ms | Interrupt `"duck"`: look for words this long after the user starts talking over a reply, and again as often while there are none. |
| `BLIP_QUIET_MS` | 300 ms | Interrupt `"duck"`: no words and quiet this long means a clap or a cough. The reply comes back up without waiting for the utterance to end. |
| `THINKING_EVERY_MS` | 1500 ms | While Claude thinks, a tick this often. |
| `THINKING_MAX_MS` | 10 000 ms | Ticks stop this long after Claude started thinking. |

`speech.onset` fires once the user has talked for `BARGE_IN_MS` (250 ms, `src/listen/utterances.ts`).

### State

`State` is `{ phase: "off" }` or `OnCall`. `OnCall` holds:

- `lastActivityAt`: when a reply last ended or the user's words last arrived. The idle timeout counts from it.
- `user`: `"talking"` from the onset of speech until the utterance ends, else `"quiet"`.
- `claude`: one of four turns.
  - `idle`.
  - `thinking`: the user's words reached Claude, and Claude has not spoken since. `since` and `lastTickAt`
    drive the tick.
  - `held`: says waiting for the user to finish their sentence (interrupt `"none"`), oldest first.
  - `speaking`: one say playing, with `startedAt`, `pausedMs` (how long earlier interruptions paused it),
    the `queue` of says after it (oldest first) and the current `interruption`, if any.
- `held` and `speaking` carry `owesReply`: the user's words reached Claude meanwhile, so Claude is thinking
  once the says have played.
- `missed`: things the user said that speech to text failed on, since the last one it heard.
- `undelivered`: words are in the inbox that nobody has handed to Claude yet.

An `Interruption` is the user talking over a reply, until their words stop it or it plays on as before. It
holds `at` (when it began), `pending` (its utterances still being transcribed), `filler` (one of them was
only a filler or nothing, so the reply resumes once the user is done) and `reply`, what the talked-over reply
does meanwhile.

- `ducked`: quieter since `since`. `check` is when to look for words next, `"asked"` while the shell looks,
  or null for no more checks.
- `paused`: paused since `since`.
- `playing`: back at full volume. There are no words yet, but the transcript still decides.

Whichever it is, words in the final transcript stop the reply.

### Events

Every event carries `at`, wall-clock ms stamped by the shell.

| Event | Meaning |
|---|---|
| `speech.onset` | The user has talked for `BARGE_IN_MS`. |
| `speech.dropped` | Sound that came to nothing: `blip` (speech too short to count) or `no-speech`. |
| `utterance.ended` | An utterance ended: `end-of-turn`, `max-duration`, or `cut` (the mic stopped hearing the user mid-sentence, because of our reply on speakers or mute). |
| `transcribed` | The final transcript's verdict from `classify`: `words`, `filler`, `hang-up` or `empty`. |
| `transcribe.failed` | Speech to text failed on that utterance. |
| `words.checked` | The answer to `words.check`: `words` true or false, or null when whisper could not take the request in time; `quietMs`, how long the user has been quiet. |
| `say.requested` | Claude called `say`. |
| `playback.ended` | The say finished, was stopped or failed. |
| `inbox.drained` | `listen`, the plugin hook or Voice Buddy took the user's words. |
| `end.requested` | An end asked for from outside: `requested` (Claude or a shutdown), `session-ended` (call.json gone), `mic-lost` (the recorder failed). |
| `tick` | The wake `nextWake` asked for. Harmless at any other time. |

### Effects

| Effect | Meaning |
|---|---|
| `speech.start` | Play the say. |
| `speech.duck` / `speech.restore` | Quieter while the user talks over it (interrupt `"duck"`); back to full volume. |
| `speech.pause` / `speech.resume` | Pause at the exact position; resume from it. |
| `speech.stop` | Stop a playing say. |
| `speech.drop` | A queued say that never plays. |
| `deliver` | Put the utterance in the inbox. `interrupted` names the reply its words stopped and `playedMs` of it played; `missed` is how many things said before it were lost. |
| `words.check` | Look for words in what the user has said so far over `say`. The answer comes back as `words.checked`. |
| `cue` | Play `thinking-tick`. |
| `teardown` | End the call for an `EndReason`: an end request, `hang-up` or `idle`. |

### Rules

`step` is total. An event that means nothing in the current state (a late `playback.ended`, a stray `tick`,
anything after the call ended) returns the state unchanged and no effects. `nextWake(state)` returns the
earliest deadline in the state, so the shell needs one timer. It returns null once the call is over.

- **Next say.** When a reply ends, the next queued say plays. With nothing queued, Claude is thinking if
  it owes a reply, else idle. On interrupt `"none"` a say waits (`held`) while the user talks, because on
  speakers the mic goes deaf while Claude speaks and would cut the user's sentence short. It starts when the
  user goes quiet. There is no timer on the hold; the recorder's 60 s sentence limit ends any utterance.
- **A say ends thinking.** `say.requested` clears `undelivered` and `owesReply`. Claude is talking, so words
  taken before the say, or returned with its result, need no ticks.
- **A ducked reply that ends under the user.** The next say starts ducked, and the same transcript decides it.
- **Thinking tick.** While thinking, a `cue` every `THINKING_EVERY_MS` until `THINKING_MAX_MS`. No tick while
  the user talks, but the 10 s limit still runs out.
- **Talking over a reply.** Onset during a reply pauses it (interrupt `"pause"`) or ducks it and schedules a
  word check (interrupt `"duck"`). A reply already paused or ducked is left alone, and the transcript still out
  decides. Onset does nothing on interrupt `"none"`.
- **Word check.** See the redesign's table. A late `words.checked` (the transcript decided first, or a newer
  check is due) changes nothing. Words pause the reply; nothing is ever dropped on a partial. A null answer
  means whisper was busy or cold, so the reply stays ducked and the final decides.
- **Final transcript.** `hang-up` ends the call from any state. For an utterance said over a reply, real words
  stop the reply, drop its queue and deliver with `interrupted`. `playedMs` is the time from `startedAt` to
  the interruption, minus `pausedMs`. A filler, a cough or empty means nothing for Claude, and the reply
  resumes. Any other utterance that is not empty is delivered.
- **Settling.** Once the user has stopped and no transcript is out, a ducked reply comes back up at once. A
  paused one resumes after a filler, or `GIVE_UP_MS` after it paused. On interrupt `"duck"` a resume also
  restores the volume. The time paused is added to `pausedMs`.
- **Missed words.** Each `transcribe.failed` adds one to `missed`. The next delivery carries the count and
  resets it.
- **Handed over.** `inbox.drained` with words undelivered makes Claude thinking, or sets `owesReply` while
  it speaks.
- **Idle.** A tick `idleMs` after `lastActivityAt` ends the call with `idle`.
- **Ending.** A paused or ducked reply is stopped so it does not stay that way. A reply that is playing
  finishes, because it is Claude's goodbye. Queued says are dropped. Then `teardown`.

### What a transcript means

`src/call/engine/words.ts` reads the words so the engine gets only the verdict.

- `classify` returns `hang-up` first, then `empty` for no text, then `filler` or `words`.
- **Hang-up** must be the whole transcript: "hang up", "hangup", "end call", "end the call", "bye Claude" or
  "goodbye Claude". Politeness and the name around it are fine ("Okay, hang up now.", "Bye, Claude."). Any
  negation ("don't", "do not", "not", "never") rules it out ("Don't hang up yet.").
- **Filler** is backchannel only ("Mm-hmm.", "Yeah, okay."): mm, mmm, hmm, mhm, mm-hmm, mm-hm, uh-huh, uh,
  um, ah, oh, okay, ok, yeah, yep, right, sure. Talking over Claude with a filler does not cut its reply.
  Sound tags whisper adds ("[BLANK_AUDIO]", "(coughs)") are not words.
- `heardSoFar(text, playedMs)` estimates the words of a reply the user heard, at 2.7 words per second (about
  how fast the voices speak), at least one word. It is off by a few words; word timings from the voices
  would fix it.
- `echoes(heard, reply)` is true when what was heard is only a stretch of the reply, two words or more. That
  is our own reply let through by the echo canceller, so the word check ignores it.

## Call session shell

`src/call/session.ts` is the shell around the engine. It owns what the engine cannot touch: the audio
session, the transcripts and reply texts (the engine knows them by id), the voice-mode files and the timers.
It turns what happens into events and performs the effects. There is one `Call`, exported as `call`.

### Audio and transcription

One audio session runs for the whole call (`listenContinuously` in `src/listen/utterances.ts`). The session
holds the mic lock throughout, so other windows' voice turns give up at once. On speakers with the process
backend the mic cannot hear the user while `say` plays (`src/audio/device.ts`). On headphones and on the
native backend it can, so the user can talk over Claude.

Each utterance is transcribed on the Mac and left in the inbox for `listen`, `say`, the plugin hook or Voice
Buddy to hand to Claude. Utterances are transcribed in the order they were said, one chain. A failure in
the chain is logged and does not stop the rest of the call being heard. The shell counts finals queued or
running, because a word check would wait behind them in whisper. The live transcript only asks for a
partial when none are. The call's `LiveTranscript` serves both the bubble's live words and the word check
(see [the live transcript](live-transcript.md)). Mic levels go to the levels file every other 30 ms frame,
as `<dB> <threshold dB>`. That is plenty for the bubble's glow, which smooths it anyway.

At start the shell prewarms whisper and Kokoro, so the first words of the call do not wait for the voice to
load. The caller of `start` runs the preflight and has Claude speak the greeting.

### Dispatch and timers

`dispatch` stamps each event with `Date.now()` and drains a queue. An event sent from inside an effect waits
its turn, so the engine never sees an event before it has finished with the previous one. One timer covers
every engine deadline (`arm`). A tick that comes early changes nothing and arms the timer again. The delay is
capped at 2^31 - 1 ms, because `setTimeout` fires at once past that.

A poll every 250 ms (`WATCH_MS`) checks the world outside the engine.

- **call.json.** If it is gone or names another pid, the session ended (the plugin hook removes it), and the
  call ends with `session-ended`. The `session` the hook adds is recorded as this window's own, so another
  window's typing cannot stop the call.
- **Permission notice.** If the permission file exists, the shell removes it and says `PERMISSION_NOTICE`.
- **Inbox.** Voice Buddy blanks an inbox entry once it has handed it to Claude, so the shell deletes empty
  files and nothing is kept. When no `.json` entry is left and the engine has words undelivered, it sends
  `inbox.drained`.

### Say

`say` queues the text and returns once it has started, or after `EARLY_FAILURE_MS` (300 ms). A say that fails
in that window (no voice installed) throws from that call. A later failure becomes a note in the next `say`
result. On interrupt `"none"` a say first waits for the user to finish their sentence. Typing does not stop
it. `speech.duck` sets the reply's gain to 0.3 (`DUCK_GAIN`). `words.check` asks the live transcript for a
partial that can start within 300 ms (`CHECK_START_MS`), since whisper serves one request at a time. A
partial counts as words when `classify` says `words` or `hang-up` and it does not echo the reply.

The shell chains every say into one promise for the next voice turn to wait on. A dropped say settles at
once, while the one before it may still play (a goodbye).

### Delivery

`deliver` adds the transcript to the inbox and wakes any waiting `listen`. An interrupted utterance is
prefixed with `(You interrupted Claude after: '<words heard so far>')`. When speech to text failed on earlier
utterances, a `voice-mcp note` tells Claude how many and why, asks it to tell the user what it did hear, and
names the failure file. The bubble gets only the transcript; the notes are for Claude.

On each speech-to-text failure the shell writes `last-stt-failure.json` in the cache dir, for debugging and a
future `/issue`: `{ at, error, failures, model, version, platform }`.

### Ending

The call ends when the user says a hang-up phrase, when Claude calls `call end`, after
`VOICE_MCP_CALL_IDLE_MINUTES` without a word either way (fractions work; the tests use seconds), when
call.json disappears, when the recorder fails, or at shutdown. Teardown runs synchronously, so a shutdown
that exits right after leaves nothing behind. It aborts the loop, empties the inbox, removes call.json and
the mute and levels files, stops the bubble and clears the phase. It stops the recorder at once; the mic is
given back once the recorder has exited, and the next `start` waits for that. `endedBecause` tells a later
`listen` or `say` why: "the user hung up", "nobody said anything for N minutes", or the reason given to
`end`.

## Phase 0 results (2026-10-29, Claude Code 2.1.312, Jeet's Mac)

Spikes in `scripts/spikes/` (throwaway; delete in Phase 1). 20 scripted utterances into an idle session each.

| Route | Result |
|---|---|
| A: `$.session.send` to its own session id | **Refused:** "no live session on this machine has id …" (self-messages aren't allowed) |
| B: mod `$.prompt.submit({ text, asUser: true })` | **20/20 delivered; end of speech → turn start median 0.14 s, p90 0.18 s, max 0.20 s**; reply ~2.5 s (model time) |
| C: Stop hook waits, then `decision: block` | Delivers, but each utterance renders as "Stop hook error: …", and after 9 consecutive blocks Claude Code overrides and ends the turn (raisable with `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`). Not used |

**Decision:** idle delivery goes through Voice Buddy's mod (route B); `listen` is the fallback. Mods are early
access, so call mode must work (degraded) without them. onnxruntime-node 1.21.0 is already in the Kokoro
cache, so Silero VAD needs no new download for Kokoro users.

## Phases

0. ~~Spikes: decide idle delivery.~~ Done: route B (above).
1. ~~**Call engine + tools + skill:** lifecycle, mic engine, queue, hang-up phrases, idle timeout, `call`/`say`/
   `listen`, chosen delivery route, half duplex, mic lock for the call, `/mac-voice-mcp:call` and `:hangup`.~~ Done.
1.5. **Talk while Claude works (found testing Phase 1):** a foreground command (a ~1 min test run) blocks
   Claude, and the hook can only hand over the user's words between steps, so nothing reached Claude
   until the tests finished.
   - **Call rule:** during a call, start long commands (tests, builds, installs, servers) in the background
     (Bash `run_in_background`), say what's running ("Tests are running, I'll tell you when they're done"),
     and check back; keep each step short so the user's words get through within seconds.
   - **Voice stop, like Esc:** if the user says a stop phrase on a call while a turn runs ("stop",
     "wait", "hold on", "Claude stop", "cancel that"; whole utterance, like hang-up phrases, not "don't
     stop"), Voice Buddy aborts the running turn with `$.turn.abort({ turnId })` (turnId from
     `turn.start`), then submits what the user said. Any other speech waits for the next step as now.
     Without Voice Buddy, a stop phrase is delivered like other words.
   - Acceptance: with the rule, a "how's it going?" during a 60 s test run reaches Claude in ≤ 5 s;
     "stop" during a foreground command ends the turn in ≤ 1 s and Claude replies to it.
2. ~~**Headphones + barge-in:** duplex auto-detect, pause/resume, filler filter.~~ Done.
3. ~~**Polish:** thinking sound, Notification hook, Voice Buddy call mood.~~ Done.
4. **Tests, docs, release:** stub e2e (continuous `rec` stub scenarios), `test:local` call scenario,
   docs (usage, configuration), changelog → 0.8.0.

## Acceptance (numbers)

| Check | Target | How |
|---|---|---|
| Utterances delivered in a 10-minute call | 100% of scripted loopback sentences, word errors ≤ 30% | `test:local` call scenario |
| Idle delivery: end of speech → Claude's turn starts | ≤ 3 s (excl. model time) | Phase 0 / `test:local` |
| Mid-turn delivery | at the next tool call | e2e |
| Barge-in: speech onset → playback paused (headphones) | ≤ 400 ms | e2e stub + `test:local` |
| False barge-in (cough, "mm-hm") resumes | within 2 s, reply not cut | e2e |
| Hang-up phrase → mic closed, no recorder left | ≤ 1 s | e2e + `test:local` |
| Silence never ends a call before the idle limit | 5 min silent call stays open | e2e (shortened timers) |
| Nothing kept | inbox empty after delivery; no transcript on disk | e2e |
| Server CPU while idle on a call | measure and report; investigate if > 5% | `test:local` |
| Existing voice mode unchanged | all current tests pass | CI |

## Risks

- Idle delivery depends on the mods API (early access): if it changes, calls fall back to `listen`.
  Voice Buddy must handle `$.prompt.submit` failing (toast once, fall back).
- `system_profiler` is slow (~1 s); fine once per call, not for polling.
- Kokoro pause/resume via process signals needs care with SoX buffers.
- Cowork bridge: tool calls over 60 s fail; `listen` waits 40 s at most.
- Seen 2026-10-30 (twice): a background task (agent or `run_in_background` command) finishing
  mid-`say` cut the spoken reply off, so the user missed it. The same notice also reached Claude
  again as if the user had said it. Cause not traced: the new turn may stop playback, or Voice Buddy
  may hand the notice over. To reproduce: on a call, `say` a long line just before a background
  command ends.

## Prior art

[claude-call](https://github.com/caiovicentino/claude-call) runs Claude Code headless (`claude -p`, separate
API credit, permissions skipped by default) with Silero VAD, whisper.cpp, an echo gate on speakers, full
duplex on headphones, and a Stop-hook mode. Same audio choices; different integration.
