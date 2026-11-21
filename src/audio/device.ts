/**
 * The audio port: everything that hears sound (turns, calls, the work listener, doctor) opens an
 * AudioSession, and everything that plays sound (replies, cues, doctor) goes through play(). Which
 * program records or plays, who owns the mic, and when the mic can't hear the user stay behind it
 * (see process.ts and mic.ts).
 */
import { existsSync } from "node:fs";
import { flightEvent } from "../flight.js";
import { SetupError } from "../proc.js";
import { muteFile } from "../state/voice-mode.js";
import { claim } from "./mic.js";
import * as backend from "./process.js";

export { exclusive, lockIfFree, MicBusyError } from "./mic.js";
export { describeRecorder, findRecorder, MIC_PERMISSION_HINT, RECORDER_MISSING } from "./process.js";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** 30 ms of mic audio. */
export interface Frame {
  /** FRAME_BYTES (960) of 16 kHz mono s16le. */
  readonly pcm: Buffer;
  /**
   * The user can't be heard in it: our own reply plays on speakers (or just stopped), or the user
   * muted the call. Neither judge it as speech nor keep it.
   */
  readonly echo: boolean;
}

/**
 * Why a session is open. A turn or a call takes the mic lock (a call's makes other sessions give
 * up at once); the work listener never takes it and gives way to any of them; doctor takes nothing.
 */
export type Purpose = "turn" | "call" | "worklisten" | "doctor";

/**
 * What a reply can do when the user talks over it: "pause" (headphones: the mic hears the user, not
 * the reply), "duck" (echo cancelled, not on this backend), or "none": its sound reaches the mic, so
 * frames are `echo` while it plays.
 */
export type Interrupt = "duck" | "pause" | "none";

export interface OpenOptions {
  purpose: Purpose;
  /** Cancels waiting for the mic. */
  signal?: AbortSignal;
  /** Called once if we have to wait for another session. */
  onWait?: () => void;
}

export interface AudioSession {
  readonly interrupt: Interrupt;
  /**
   * The mic from now on: the recorder starts here. Call it once. Ends when the session closes,
   * throws when the mic stops on its own; return() stops the recorder without waiting for it.
   */
  frames(): AsyncIterableIterator<Frame>;
  /** Aborts when the session closes, or the mic is taken from it (the work listener). */
  readonly signal: AbortSignal;
  /** Resolves once the session is over: the mic really closed and given back. */
  readonly ended: Promise<void>;
  /** Close the mic and give it back. Idempotent; resolves with `ended`. */
  close(): Promise<void>;
}

/** Our own reply reaches the mic a moment after it stops. */
const ECHO_TAIL_MS = 300;
/** How often a call checks whether the user muted it. */
const MUTE_POLL_MS = 250;

/**
 * The one routing rule. Only a call plays replies while its mic is open: on headphones a reply can
 * pause for the user, on speakers its sound reaches the mic.
 */
async function route(purpose: Purpose): Promise<Interrupt> {
  if (purpose !== "call") return "none";
  return (await backend.detectDuplex()) === "full" ? "pause" : "none";
}

/** Open the mic for `purpose`: waits for it, or takes it from the work listener. */
export async function openAudio(opts: OpenOptions): Promise<AudioSession> {
  const interrupt = await route(opts.purpose); // before taking the mic, so a cancel meanwhile still ends the wait
  const mic = await claim(opts.purpose, opts);
  const ctl = new AbortController();
  let recording: backend.Recording | null = null;
  let muted = false;
  const mute =
    opts.purpose === "call"
      ? setInterval(() => {
          const now = existsSync(muteFile());
          if (now !== muted) flightEvent("call.mute", { muted: now, why: "user" }, null);
          muted = now;
        }, MUTE_POLL_MS)
      : undefined;
  const echo = opts.purpose === "call" ? () => muted || (interrupt === "none" && replyAudible()) : () => false;

  let markEnded!: () => void;
  const ended = new Promise<void>((r) => (markEnded = r));
  let closing: Promise<void> | null = null;
  const close = () =>
    (closing ??= (async () => {
      ctl.abort();
      clearInterval(mute);
      recording?.stop();
      await recording?.exited;
      mic.release();
      markEnded();
    })());
  mic.preempted.addEventListener("abort", () => void close(), { once: true });

  return {
    interrupt,
    signal: ctl.signal,
    ended,
    close,
    frames() {
      const recorder = backend.findRecorder();
      if (!recorder) throw new SetupError(backend.RECORDER_MISSING);
      const inner = ctl.signal.aborted ? null : (recording = backend.record(recorder)).frames;
      const it: AsyncIterableIterator<Frame> = {
        [Symbol.asyncIterator]: () => it,
        async next() {
          const r = await inner?.next();
          return !r || r.done ? { value: undefined, done: true } : { value: { pcm: r.value, echo: echo() }, done: false };
        },
        async return() {
          await inner?.return!();
          return { value: undefined, done: true };
        },
      };
      return it;
    },
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** The one PCM rate speech is played at: 24 kHz mono s16le. */
export const SPEECH_RATE = 24_000;

export type Sound =
  /** Speech as PCM, one buffer per sentence, so the first sentence plays while the rest renders. */
  | { kind: "speech"; chunks: AsyncIterable<Buffer> }
  /**
   * The built-in voice speaking on its own (macOS `say`, espeak-ng, Windows SAPI). Not PCM: this
   * backend lets `say` play directly, so a voice started ahead of time keeps its first-sound latency.
   * `input` goes on stdin; without it the text is already in `args`.
   * shortcut: a process launcher in the port, which the native backend can't honour; replace with
   * `{ kind: "voice"; text }` (the backend owning command and standby) before the native backend plays speech.
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

/** Replies (speech, not cues) playing now, and when the last one stopped. */
let replies = 0;
let replyStoppedAt = -Infinity;
const replyAudible = () => replies > 0 || Date.now() - replyStoppedAt < ECHO_TAIL_MS;

/** Play a sound. Returns at once. */
export function play(sound: Sound): Playback {
  const playback = backend.play(sound);
  // A cue is too short to count as speech (the thinking tick plays while the call listens).
  if (sound.kind !== "cue") {
    replies++;
    const stopped = () => {
      replies--;
      replyStoppedAt = Date.now();
    };
    playback.done.then(stopped, stopped);
  }
  return playback;
}
