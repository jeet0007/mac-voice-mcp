# Voice cues and spoken errors (unreleased)

Status: design · Owner: Jeet · Designed by the Voice MCP UX Designer · Source to change: `src/audio.ts`
(`chime`), `src/voice.ts` (`turn`), `src/worklisten.ts`, `src/setup.ts`, new `src/cues.ts`

## Problem

1. The mic cues don't tell apart "got it" from "I heard nothing": a silent room and a finished sentence both
   end with the same Pop.
2. When a voice turn can't work (mic blocked, no recorder, no whisper, no model), the reason goes
   only to Claude as text. A hands-free user hears nothing, and Claude's reply to that text is often another
   `speak_and_listen`, which fails the same way.

## Principles

- **Sound says what happened; words say what to do.** A tone is instant and language-free; a short spoken
  line is for the cases the user must act on.
- **Calm.** No alarms. Quiet system sounds, 0.6 volume at most, nothing over 1 s except Pop's soft tail.
- **Never nag.** An error is spoken once per kind per 10 minutes; every failure still gets its tone.
- **Local and built in.** macOS system sounds (`/System/Library/Sounds`) through `afplay`, and the built-in
  voice (`say`, honouring `VOICE_MCP_VOICE`) through the existing `speak` path with Kokoro skipped, because
  Kokoro may be what is broken and `say` needs no setup. Nothing downloaded, nothing leaves the Mac.
- **Never record the cue.** Cues play only while the mic is closed, except the mic-open Tink, which already
  waits for `MIC_WARMUP_MS` and the existing echo tail.

## Cues

Durations measured from the files (`afinfo`). Volumes are `afplay -v`.

| When | Sound | Volume | Length | Why this one | Change |
|---|---|---|---|---|---|
| **Mic open** (recording really started, after `MIC_WARMUP_MS`) | Tink | 0.6 | 0.56 s | short, high, "go ahead" | none |
| **Mic closed, words were heard** (end of speech) | Pop | 0.5 | 1.6 s (soft decay) | familiar "got it" | volume 0.6 to 0.5: Pop's tail is long and the user may already be listening for Claude |
| **Mic closed, no speech** (start timeout: user never spoke) | Purr | 0.45 | 0.76 s | low and soft: "nothing came in", clearly unlike Pop, not a failure | new |
| **Heard a sound, but whisper found no words** (cough, door) | Pop at once, then Purr 0.45 the moment the empty transcript is known (a Pop still playing is stopped, never waited for) | | | the Pop is instant feedback that recording stopped; Purr says it didn't count | new |
| **Error** (anything in the table below, except a busy mic) | Basso | 0.6 | 0.77 s | low "no", the standard macOS error tone | new |
| Thinking tick (calls), work-listener "got it" | unchanged | | | | none |

- `VOICE_MCP_CHIME=0` turns off **all** the tones above (existing switch, wider reach). It does not silence
  spoken errors; see below.
- A "no speech" ending should sound different from a normal close: yes (Purr vs Pop). The two are the most
  common endings; telling them apart by ear lets a user who looked away know whether to repeat themselves.
- No cue for mute or hang-up: the bubble shows them.
- Volume stays under the system volume; no ducking, no per-sound env knobs in v1.

## Spoken errors

When a voice turn can't work, voice-mcp plays **Basso**, waits **200 ms**, and says one line with the
built-in voice. Plain words, 12 words or fewer, no paths, no commands (the user may be across the room; the
fix goes on screen via Claude).

| Failure (where it is detected) | Spoken line | Words |
|---|---|---|
| Digital silence: mic blocked or wrong device (`heard.digitalSilence`, `src/voice.ts`) | "I only hear silence. Please allow microphone access for this app." | 11 |
| No recorder (`RECORDER_MISSING`, `src/audio.ts`) | "I can't record yet. Please check the screen for setup." | 10 |
| No whisper (`STT_MISSING`, `src/stt.ts`) | "I can't understand speech yet. Please check the screen for setup." | 11 |
| Model missing (preflight finds no model) | "My speech model is missing. Please check the screen for setup." | 11 |
| Model still downloading (`isModelDownloading`) | "My speech model is still downloading. Try again in a minute." | 11 |
| Mic busy in another window (`MicBusyError`, `src/lock.ts`) | **none: no tone, no line** | |

Rules:

1. **When.** Only on a turn that wanted to listen (`speak_and_listen`, `listen`), and for calls, the same
   helper. Setup errors happen before Claude's text is spoken, so the user hears Basso and the line only.
   Claude's original text is not spoken on a failed turn.
2. **Once per kind per 10 minutes** per server process (a `Map<kind, lastSpokenAt>`). Within that window a
   repeat failure plays the Basso only. The first one after 10 minutes speaks again.
3. **Mic busy is never spoken and has no tone.** Another window's session has the mic open, so our voice
   would be recorded and transcribed as that user's words. The tool result keeps today's text only.
4. **Order.** `finishSpeaking()` first (one speaker), release the mic lock, then Basso, 200 ms, then the line.
   Total about 2.5 s. Never while the mic is open.
5. **`VOICE_MCP_CHIME=0`:** skips the tone, still speaks the line. New `VOICE_MCP_SPOKEN_ERRORS=0` turns the
   lines off (default `1`); document in `docs/configuration.md`.
6. **If `say` is missing** (non-macOS, or `speak` throws): tone only; the text result is unchanged.
7. **Fixed strings only.** Never a transcript, a path or an error message in the spoken line.

### What Claude is told

The tool result keeps today's text (it explains the fix) and gets one extra note, so Claude doesn't repeat it
aloud or retry in a loop:

- Spoken now: `voice-mcp note: the user already heard this out loud ("<line>"). Do not say it again by voice,
  and do not call speak_and_listen again until it is fixed. Explain the fix on screen.`
- Tone only (inside the 10-minute window): `voice-mcp note: the user heard an error tone, and the spoken
  explanation earlier. Do not say it by voice, and do not call speak_and_listen again until it is fixed.
  Explain the fix on screen.`

Both go in `notes` (the existing "voice-mcp note" channel). Add to `SERVER_INSTRUCTIONS` (still under the
2 KB cap; check) one line: `A "voice-mcp note" saying the user already heard an error means: explain on
screen, don't retry by voice.`

## Code shape (for the Engineer)

```ts
// src/cues.ts
export type Cue = "open" | "close" | "no-speech" | "error";
export const CUES: Record<Cue, { sound: string; volume: number }> = {
  open: { sound: "Tink", volume: 0.6 },
  close: { sound: "Pop", volume: 0.5 },
  "no-speech": { sound: "Purr", volume: 0.45 },
  error: { sound: "Basso", volume: 0.6 },
};
export type SpokenError = "silence" | "no-recorder" | "no-whisper" | "no-model" | "model-downloading";
export const SPOKEN_ERRORS: Record<SpokenError, string> = { /* the five lines above, verbatim */ };
export async function cue(c: Cue): Promise<void>;                    // honours CONFIG.chime
export async function announceError(kind: SpokenError): Promise<{ spoken: boolean; line: string }>; // tone + 200 ms + say, dedupe
```

`chime(kind)` keeps working as a thin wrapper so `worklisten.ts` is untouched. In `turn`:
`heard.digitalSilence` → `announceError("silence")` instead of the close chime; `reason === "no-speech"` →
`cue("no-speech")`; otherwise `cue("close")`, then `cue("no-speech")` if the transcript is empty.
`SetupError`s with `RECORDER_MISSING` / `STT_MISSING` and the model preflight → `announceError(...)` before
the error is returned.

## First-run touches to the `voice_setup` report (`src/setup.ts`)

Small, optional.

1. The microphone line, today `• Microphone: macOS asks for permission the first time speak_and_listen
   listens — click Allow.` becomes: `• Microphone: the first time it listens, macOS asks to allow microphone
   access for this app (Terminal, Claude, Cursor …). Click Allow.`
2. Add one line under it: `• Sounds: a soft tick means the mic is open, a pop means it heard you, a low
   purr means it heard nothing, a low thud means something is wrong (it also says what).` (Claude relays this
   once; the line is for it to tell the user.)
3. On READY, replace `Next: everything is in place — speak_and_listen is ready to use.` with the same text
   plus ` Tell the user once, in one sentence, what the tick means.`
4. On the first READY that follows an `install=true` run (never on a plain check): say
   "Voice is ready. You'll hear a tick when I'm listening." (10 words) with the built-in voice, once per
   server process, skipped when `VOICE_MCP_SPOKEN_ERRORS=0`.

## Acceptance

- Test with fake `afplay` and `say` first on `PATH`: records arguments, plays nothing (no real audio in CI).
- Mic open: `Tink` at 0.6; closed after words: `Pop` at 0.5; no speech: `Purr` at 0.45 and no Pop;
  empty transcript: `Pop` then `Purr`; each failure kind: `Basso` at 0.6, then the exact line from the table.
- Second failure of the same kind within 10 minutes: Basso only; after 10 minutes (fake clock): spoken again.
- `VOICE_MCP_CHIME=0`: no `afplay` call for any cue, error lines still spoken. `VOICE_MCP_SPOKEN_ERRORS=0`:
  no `say` call, tones still play.
- Every spoken line is 12 words or fewer and matches `/^[A-Za-z' .,]+$/` (no paths, digits or symbols).
- Tool results carry the matching `voice-mcp note`, and `SERVER_INSTRUCTIONS` stays under 2 KB.
- Nothing spoken or played while the mic is recording (the cue helpers are called only after the recorder
  stopped, except `open`).
- `docs/configuration.md`, `docs/troubleshooting.md` (what each sound means) and CHANGELOG updated.
  `npm test` passes.

## Not in this spec

New sound files, user-pickable sounds, volume settings, speaking errors through Kokoro, localisation of the
spoken lines (English only in v1), sounds for mute and hang-up.

## Review rules (added after the Privacy and UX review)

- **No line without a note.** Whenever the tone played but no line was said (VOICE_MCP_SPOKEN_ERRORS=0, another
  session holds the mic, or `say` failed), Claude still gets a "voice-mcp note": the user heard an error tone
  only; explain on screen and don't call `speak_and_listen` again until it is fixed.
- **Another session's open mic.** Before any error line or the ready line, the mic lock is taken without waiting.
  Held elsewhere: the tone only (errors) or nothing (ready line), never a spoken line. Free: the line is spoken
  with the lock held, so no other session opens its mic over it. At the end of a turn the line is spoken after the
  recorder has exited and before the lock is released.
