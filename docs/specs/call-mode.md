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
| Claude idle (Claude Code with Voice Buddy) | **Voice Buddy's mod** submits the utterance with `$.prompt.submit({ text, asUser: true })` (Phase 0 route B: 20/20, turn starts in 0.14 s) |
| Claude idle (no Voice Buddy, Desktop, Cursor) | Claude keeps calling `listen` (call rules say: always end a turn with `listen`) |

Channels are the purpose-built route but need `--dangerously-load-development-channels` during the research
preview, so they're an opt-in extra, not the default.

### No dead air

After delivering an utterance, play a soft tick every ~1.5 s until Claude's next `say` or 10 s pass
(`VOICE_MCP_CALL_THINKING_SOUND=0` turns it off). Permission prompts: a Notification hook says "Claude needs
your OK on screen" so the call doesn't silently stall.

### Voice Buddy

New mood "on a call" (with duration) for the calling window; speaking/listening colours as today.

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
