/**
 * The audio port's output half: everything that plays sound (replies, cues, doctor) goes through
 * play(). Which program plays it, and how a duck is done, stays behind it (see process.ts).
 */
import * as backend from "./process.js";

/** The one PCM rate speech is played at: 24 kHz mono s16le. */
export const SPEECH_RATE = 24_000;

export type Sound =
  /** Speech as PCM, one buffer per sentence, so the first sentence plays while the rest renders. */
  | { kind: "speech"; chunks: AsyncIterable<Buffer> }
  /**
   * The built-in voice speaking on its own (macOS `say`, espeak-ng, Windows SAPI). Not PCM: this
   * backend lets `say` play directly, so a voice started ahead of time keeps its first-sound latency.
   * `input` goes on stdin; without it the text is already in `args`.
   */
  | { kind: "voice"; bin: string; args: string[]; input?: string; standby: boolean }
  /** A short sound file (a cue). */
  | { kind: "cue"; file: string; volume: number };

export type PlayEnd = "finished" | "stopped";

export interface Playback {
  /**
   * Settles once the player is gone: "finished", "stopped" after stop(), or rejects when the player
   * died or failed (or a speech source threw: the player is stopped at once).
   */
  readonly done: Promise<PlayEnd>;
  /** 1 = full volume. This backend can't ramp gain, so below 1 it pauses and at 1 resumes (not on Windows). Idempotent. */
  duck(gain: number): void;
  /** Stop now, also while paused. Idempotent. */
  stop(): void;
  /** Milliseconds played so far (wall clock minus time paused). */
  playedMs(): number;
}

/** Play a sound. Returns at once. */
export function play(sound: Sound): Playback {
  return backend.play(sound);
}

/** Can a call keep the mic open while Claude speaks? "full" on headphones (no echo to hear back). */
export function detectDuplex(): Promise<"full" | "half"> {
  return backend.detectDuplex();
}
