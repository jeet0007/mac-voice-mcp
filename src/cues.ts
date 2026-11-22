// The mic's tones and the fixed spoken error lines. See docs/specs/voice-cues.md.
import { existsSync } from "node:fs";
import { lockIfFree, play } from "./audio/device.js";
import { CONFIG, debug, IS_MAC } from "./config.js";
import { sleep } from "./proc.js";

export type Cue = "open" | "close" | "no-speech" | "error";

export const CUES: Record<Cue, { sound: string; volume: number }> = {
  open: { sound: "Tink", volume: 0.6 },
  close: { sound: "Pop", volume: 0.5 },
  "no-speech": { sound: "Purr", volume: 0.45 },
  error: { sound: "Basso", volume: 0.6 },
};

// No "mic busy" kind on purpose: our voice would be transcribed as the other session's user.
export type SpokenError = "silence" | "no-recorder" | "no-whisper" | "no-model" | "model-downloading";

export const SPOKEN_ERRORS: Record<SpokenError, string> = {
  silence: "I only hear silence. Please allow microphone access for this app.",
  "no-recorder": "I can't record yet. Please check the screen for setup.",
  "no-whisper": "I can't understand speech yet. Please check the screen for setup.",
  "no-model": "My speech model is missing. Please check the screen for setup.",
  "model-downloading": "My speech model is still downloading. Try again in a minute.",
};

export const READY_LINE = "Voice is ready. You'll hear a tick when I'm listening.";

export const REPEAT_WINDOW_MS = 10 * 60_000;
const AFTER_TONE_MS = 200;

export async function playSound(name: string, volume: number, signal?: AbortSignal): Promise<boolean> {
  const sound = `/System/Library/Sounds/${name}.aiff`;
  if (!IS_MAC || !existsSync(sound) || signal?.aborted) return false;
  const playback = play({ kind: "cue", file: sound, volume });
  signal?.addEventListener("abort", () => playback.stop(), { once: true });
  return playback.done.then(
    (end) => end === "finished",
    () => false,
  );
}

// Built-in voice, not Kokoro: Kokoro may be what is broken.
async function sayBuiltIn(line: string): Promise<void> {
  await play({ kind: "voice", text: line }).done;
}

export async function cue(c: Cue, signal?: AbortSignal): Promise<boolean> {
  if (!CONFIG.chime) return false;
  return playSound(CUES[c].sound, CUES[c].volume, signal);
}

export async function chime(kind: "start" | "stop"): Promise<void> {
  if (kind === "start") await cue("open");
  else if (CONFIG.chime) await playSound("Pop", 0.6);
}

// 60 ms of sound: too short for the endpointer to take as speech.
export const thinkingTick = () => playSound("Tink", 0.2);

const lastSpoken = new Map<SpokenError, number>();

export function resetAnnounced(): void {
  lastSpoken.clear();
}

export interface Announced {
  spoken: boolean;
  line: string;
  repeat: boolean;
  toned?: boolean;
  micElsewhere?: boolean;
}

// Call only after the speaker and the mic are free.
export async function announceError(kind: SpokenError, opts: { now?: number } = {}): Promise<Announced> {
  const line = SPOKEN_ERRORS[kind];
  const now = opts.now ?? Date.now();
  const before = lastSpoken.get(kind);
  const repeat = before !== undefined && now - before < REPEAT_WINDOW_MS;
  const toned = await cue("error");
  if (!CONFIG.spokenErrors || repeat) return { spoken: false, line, repeat, toned };
  if (toned) await sleep(AFTER_TONE_MS);
  try {
    await sayBuiltIn(line);
  } catch (err) {
    debug("spoken error line failed:", err instanceof Error ? err.message : err);
    return { spoken: false, line, repeat: false, toned };
  }
  lastSpoken.set(kind, now);
  return { spoken: true, line, repeat: false, toned };
}

export async function announceErrorIfMicFree(kind: SpokenError): Promise<Announced> {
  const release = await lockIfFree();
  // Even the tone would land in the other session's recording.
  if (!release) return { spoken: false, line: SPOKEN_ERRORS[kind], repeat: false, toned: false, micElsewhere: true };
  try {
    return await announceError(kind);
  } finally {
    release();
  }
}

export async function sayLineIfMicFree(line: string): Promise<boolean> {
  const release = await lockIfFree();
  if (!release) return false;
  try {
    return await sayLine(line);
  } finally {
    release();
  }
}

export async function sayLine(line: string): Promise<boolean> {
  try {
    await sayBuiltIn(line);
    return true;
  } catch (err) {
    debug("spoken line failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

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
  // Without a note Claude could retry by voice in a loop.
  return (
    (a.toned ? "voice-mcp note: the user heard an error tone only, with no spoken explanation. " : "voice-mcp note: voice can't work right now, and nothing was said out loud. ") +
    "Do not say it by voice, and do not call speak_and_listen again until it is fixed. Explain the fix on screen."
  );
}
