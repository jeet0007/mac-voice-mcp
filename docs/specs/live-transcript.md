# Live transcript next to the call bubble (unreleased)

Status: in progress · Owner: Jeet · Target: next minor

## Goal

> "Show a live transcript on an attached window as I speak, so I know it heard correctly. Only visible when
> I talk, and gone when it isn't hearing any words."

During a call, a small panel attached to the floating call bubble shows the user's words while they speak,
then the final transcript for a moment, then fades away.

## Scope

- **v1: calls.** The panel belongs to the call bubble (native/call-bubble.swift), which runs during calls.
- **Not in v1:** plain `speak_and_listen` turns (no bubble runs then), Voice Buddy's in-terminal status line
  (it reads files, and partial words must not go to disk), a transcript history, editing a transcript.

## How it works

1. **Partials.** While the user is talking in a call, the server re-transcribes the current utterance with the
   warm `whisper-server` about every 700 ms (`VOICE_MCP_LIVE_TRANSCRIPT_MS`, 400-2000):
   - only when at least 0.5 s of speech is in the utterance and no partial request is in flight;
   - not when the last 300 ms were quiet (the utterance is probably ending; no new words to show, and the
     final transcript must not queue behind a partial);
   - audio goes in memory (a WAV buffer in the request body), at most the last 30 s;
   - a reply older than the newest one shown is dropped;
   - the text passes through `cleanTranscript`; an empty result shows nothing.
   - Never with the `whisper-cli` fallback (one process per request is too slow): no server, no partials.
2. **Final.** The existing per-utterance transcript (call.ts `heard`) is sent as the final text. Partials are
   display only: they never reach the inbox, Claude, logs or the flight recorder.
3. **Transport.** The server that launched the bubble writes one JSON object per line to the bubble's stdin:
   `{"type":"partial","text":"…"}`, `{"type":"final","text":"…"}`, `{"type":"clear"}`. No files, no sockets.
   A bubble started by another server process gets no text (it keeps working as today).
4. **Switch.** `VOICE_MCP_LIVE_TRANSCRIPT=1` (default) or `0`. With the bubble off, nothing runs.

## UX

Designed by the Voice MCP UX Designer: placement and attachment to the bubble, size and type, appear and fade
timing (about 1.5-2 s after the last new word; hidden when the mic closes; final text shown briefly), partial
versus final styling, accessibility (VoiceOver, contrast, text size), light and dark, Reduce Motion, never
taking focus or blocking clicks. See the section below, filled in by the designer.

<!-- UX DESIGN: to be written by the Voice MCP UX Designer -->

## Performance budget

Measured by the Voice Performance Tester with a scripted (file-fed) recorder and the real `whisper-server`,
no mic or speakers:

- Final transcript latency (end of speech to final text): no more than 50 ms worse at the median than with
  live transcript off; the worst case is at most one partial inference.
- Extra CPU while talking: reported (whisper-server busy time per second of speech).
- Time from a word being said to it showing: reported.

## Privacy

- Partial words exist only in memory, in the server and the bubble. Nothing new is written to disk (the call's
  existing per-utterance WAV and inbox are unchanged). Nothing leaves the Mac: `whisper-server` listens on
  127.0.0.1 and the bubble is a local child process.
- Not logged, not even with `VOICE_MCP_DEBUG`. The flight recorder records at most counts and timings
  (`partials`, `partialMs`), never text.
- The bubble writes nothing; it drops the text when the panel hides.
- Privacy Reviewer sign-off before this is called done.

## Acceptance

- With the bubble running and a call on, a scripted utterance produces at least one `partial` line and then
  one `final` line on the bubble's stdin, in order; a cough-only utterance produces none.
- No partial while the last 300 ms were quiet; never two partial requests at once; stale replies dropped.
- `VOICE_MCP_LIVE_TRANSCRIPT=0`, the bubble off, or no whisper-server: no partial requests at all.
- No new files are created during a call with live transcript on (test lists the cache and temp folders).
- Partials never reach the inbox or the tool results.
- The Swift panel shows partial and final text per the UX section, fades on time, hides at mic close, does
  not take focus or clicks (the bubble's existing behaviour), and respects Reduce Motion. `swiftc` build
  check passes; visual behaviour is reviewed by the UX Designer from code and screenshots of a scripted run.
- Performance budget met, with numbers.
- `docs/` and CHANGELOG updated. `npm test` passes.
