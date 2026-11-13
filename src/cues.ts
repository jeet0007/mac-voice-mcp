/**
 * The mic's sounds and the spoken errors (docs/specs/voice-cues.md).
 *
 * Sound says what happened (instant, no language); words say what to do (one fixed line, only when
 * the user must act). Quiet macOS system sounds through `afplay`, and the built-in voice for the
 * line: Kokoro is skipped on purpose, since it may be what is broken and `say` needs no setup.
 * Nothing is downloaded and nothing leaves the Mac. Play these only while the mic is closed
 * (the "open" tone is the exception: it already waits out the mic warm-up and the echo tail).
 */
import { existsSync } from "node:fs";
import { speakBuiltIn } from "./audio.js";
import { CONFIG, debug, IS_MAC } from "./config.js";
import { run, sleep, which } from "./proc.js";

export type Cue = "open" | "close" | "no-speech" | "error";

export const CUES: Record<Cue, { sound: string; volume: number }> = {
  open: { sound: "Tink", volume: 0.6 },
  close: { sound: "Pop", volume: 0.5 },
  "no-speech": { sound: "Purr", volume: 0.45 },
  error: { sound: "Basso", volume: 0.6 },
};

/**
 * A mic busy in another window is not on this list on purpose: our voice would be recorded and
 * transcribed as that other session's user, so it stays a text result only.
 */
export type SpokenError = "silence" | "no-recorder" | "no-whisper" | "no-model" | "model-downloading";

export const SPOKEN_ERRORS: Record<SpokenError, string> = {
  silence: "I only hear silence. Please allow microphone access for this app.",
  "no-recorder": "I can't record yet. Please check the screen for setup.",
  "no-whisper": "I can't understand speech yet. Please check the screen for setup.",
  "no-model": "My speech model is missing. Please check the screen for setup.",
  "model-downloading": "My speech model is still downloading. Try again in a minute.",
};

/** Said once, after a first install finishes (voice_setup). */
export const READY_LINE = "Voice is ready. You'll hear a tick when I'm listening.";

/** The same failure is spoken once per this long (per server process); in between it only gets the tone. */
export const REPEAT_WINDOW_MS = 10 * 60_000;
/** Between the error tone and the line. */
const AFTER_TONE_MS = 200;

/** Play a system sound; true when it played. A missing sound or player is never fatal. macOS only. */
export async function playSound(name: string, volume: number): Promise<boolean> {
  const sound = `/System/Library/Sounds/${name}.aiff`;
  if (!IS_MAC || !existsSync(sound)) return false;
  try {
    await run(which("afplay") ?? "/usr/bin/afplay", ["-v", String(volume), sound], { timeoutMs: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** One cue's tone. VOICE_MCP_CHIME=0 turns every tone off. */
export async function cue(c: Cue): Promise<boolean> {
  if (!CONFIG.chime) return false;
  return playSound(CUES[c].sound, CUES[c].volume);
}

const lastSpoken = new Map<SpokenError, number>();

/** Forget what was spoken (tests). */
export function resetAnnounced(): void {
  lastSpoken.clear();
}

export interface Announced {
  /** The line was said out loud. */
  spoken: boolean;
  line: string;
  /** Spoken earlier in the window, so only the tone played. */
  repeat: boolean;
}

/**
 * A voice turn can't work: the error tone, 200 ms, then one fixed line in the built-in voice,
 * unless this failure was spoken in the last 10 minutes (tone only) or VOICE_MCP_SPOKEN_ERRORS=0.
 * Call it after the speaker and the mic are free. Never throws: if `say` is missing, the tone is all there is.
 */
export async function announceError(kind: SpokenError, opts: { now?: number } = {}): Promise<Announced> {
  const line = SPOKEN_ERRORS[kind];
  const now = opts.now ?? Date.now();
  const before = lastSpoken.get(kind);
  const repeat = before !== undefined && now - before < REPEAT_WINDOW_MS;
  const toned = await cue("error");
  if (!CONFIG.spokenErrors || repeat) return { spoken: false, line, repeat };
  if (toned) await sleep(AFTER_TONE_MS);
  try {
    await speakBuiltIn(line);
  } catch (err) {
    debug("spoken error line failed:", err instanceof Error ? err.message : err);
    return { spoken: false, line, repeat: false };
  }
  lastSpoken.set(kind, now);
  return { spoken: true, line, repeat: false };
}

/** Say one fixed line in the built-in voice (never throws). */
export async function sayLine(line: string): Promise<boolean> {
  try {
    await speakBuiltIn(line);
    return true;
  } catch (err) {
    debug("spoken line failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

/** What Claude is told, so it doesn't repeat the error aloud or retry by voice in a loop. */
export function errorNote(a: Announced): string | null {
  if (a.spoken) {
    return (
      `voice-mcp note: the user already heard this out loud ("${a.line}"). Do not say it again by voice, ` +
      "and do not call speak_and_listen again until it is fixed. Explain the fix on screen."
    );
  }
  if (a.repeat) {
    return (
      "voice-mcp note: the user heard an error tone, and the spoken explanation earlier. Do not say it by voice, " +
      "and do not call speak_and_listen again until it is fixed. Explain the fix on screen."
    );
  }
  return null;
}
