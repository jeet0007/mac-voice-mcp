# Call mode (0.8.0)

Status: planned · Owner: Jeet · Target: 0.8.0 (Mac, headphones first); speakers 0.9.0; Windows after.

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
| Recorder + turn-taking (energy VAD, end silence) | `audio.ts`, `endpointer.ts` | Segment the open mic into utterances |
| Listen while Claude works, inbox, hook delivery | `worklisten.ts`, `hooks/voice-mode-lib.mjs` | Becomes the call's mic engine, without the "Claude, …" wake word |
| Warm whisper-server | `stt.ts` | Transcribe each utterance |
| Kokoro streaming playback, background speech | `kokoro.ts`, `voice.ts` | `say`, pause/resume for barge-in |
| Stop file (typing interrupts) | `worklisten.ts` | Typing still interrupts; hang-up also uses it |
| Mic lock across windows | `lock.ts` | Held for the whole call |
| Phase file + Voice Buddy | `worklisten.ts`, `plugins/voice-buddy` | Show "on a call" |

## Design

### Call lifecycle

- **Start:** `/mac-voice-mcp:call` (Claude Code skill) or the `call` MCP prompt (Desktop/Cursor). Claude calls
  `call { action: "start" }`; the server takes the mic lock, starts the mic engine, writes
  `voice-mode/call.json` `{ session, startedAt, duplex }`, and says a short greeting.
- **During:** the mic stays open. Silence never ends the call.
- **End:** the user says a hang-up phrase ("hang up", "bye Claude", "end the call"), types `/mac-voice-mcp:hangup`,
  or Claude calls `call { action: "end" }`. Also ends on session end, or after `VOICE_MCP_CALL_IDLE_MINUTES`
  (default 30) with nobody speaking. Ending stops the recorder within 1 s, releases the lock, deletes the
  inbox, says "Bye".
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

- **half (speakers):** mic is gated while Claude speaks (what claude-call calls an echo gate); the call stays open.
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
| Claude idle (Claude Code) | **Decided by Phase 0**: (A) cross-session messaging socket, self-message; (B) Voice Buddy mod `$.prompt.submit({ text, asUser: true })`; (C) Stop hook that waits for the next utterance and blocks with it (re-armed each turn; mind the 8-consecutive-block cap and 600 s default timeout) |
| Claude idle (Desktop, Cursor, or if A–C fail) | Claude keeps calling `listen` (call rules say: always end a turn with `listen`) |

Channels are the purpose-built route but need `--dangerously-load-development-channels` during the research
preview, so they're an opt-in extra, not the default.

### No dead air

After delivering an utterance, play a soft tick every ~1.5 s until Claude's next `say` or 10 s pass
(`VOICE_MCP_CALL_THINKING_SOUND=0` turns it off). Permission prompts: a Notification hook says "Claude needs
your OK on screen" so the call doesn't silently stall.

### Voice Buddy

New mood "on a call" (with duration) for the calling window; speaking/listening colours as today.

## Phases

0. **Spikes on Jeet's Mac (decide delivery):** A, B, C each deliver 20 scripted utterances into an idle
   Claude Code 2.1.310 session. Measure: delivered/20, end of speech → Claude starts (s), any UI glitches.
   Pick the best; keep `listen` as fallback. Also: is onnxruntime-node present in the Kokoro cache?
1. **Call engine + tools + skill:** lifecycle, mic engine, queue, hang-up phrases, idle timeout, `call`/`say`/
   `listen`, chosen delivery route, half duplex, mic lock for the call, `/mac-voice-mcp:call` and `:hangup`.
2. **Headphones + barge-in:** duplex auto-detect, pause/resume, filler filter.
3. **Polish:** thinking sound, Notification hook, Voice Buddy call mood.
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

- Phase 0 routes are early-access or undocumented (mods API, socket payload); keep the `listen` fallback.
- Stop-hook route: 8-block cap and timeouts; UI behaviour while a hook waits is undocumented.
- `system_profiler` is slow (~1 s); fine once per call, not for polling.
- Kokoro pause/resume via process signals needs care with SoX buffers.
- Cowork bridge: tool calls over 60 s fail; `listen` waits 40 s at most.

## Prior art

[claude-call](https://github.com/caiovicentino/claude-call) runs Claude Code headless (`claude -p`, separate
API credit, permissions skipped by default) with Silero VAD, whisper.cpp, an echo gate on speakers, full
duplex on headphones, and a Stop-hook mode. Same audio choices; different integration.
