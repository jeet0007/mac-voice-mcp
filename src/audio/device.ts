/**
 * The audio port: everything that hears sound (turns, calls, the work listener, doctor) opens an
 * AudioSession, and everything that plays sound (replies, cues, doctor) goes through play(). Which
 * program records or plays, who owns the mic, and when the mic can't hear the user stay behind it
 * (see process.ts and mic.ts).
 */
import { existsSync } from "node:fs";
import { CONFIG, IS_MACOS_15, log } from "../config.js";
import { flightEvent } from "../flight.js";
import { nativeState } from "../native-build.js";
import { SetupError } from "../proc.js";
import { muteFile } from "../state/voice-mode.js";
import { claim, MicBusyError } from "./mic.js";
import * as native from "./native.js";
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
 * the reply), "duck" (the native backend: its sound is cancelled from the mic), or "none": its sound reaches the mic, so
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

/** A worker failed in this process: calls stay on the process backend until the server restarts. */
let nativeBroken = false;
/** The native session's worker, which plays every sound while it runs. */
let liveWorker: native.Worker | null = null;
/** Process recorders still running, until they exit. */
const recorders = new Set<Promise<void>>();

/**
 * The one routing rule. Only a call plays replies while its mic is open. "duck" is the native backend:
 * with VOICE_MCP_AUDIO=native on macOS 15+, once setup built the worker, on the Mac's own or wired
 * speakers. Otherwise, on headphones a reply can pause for the user, and on speakers its sound reaches the mic.
 */
async function route(purpose: Purpose): Promise<Interrupt> {
  if (purpose !== "call") return "none";
  // Headphones stay on the process backend, so does a VOICE_MCP_CALL_DUPLEX that says what it wants.
  const native = CONFIG.audio === "native" && IS_MACOS_15 && CONFIG.callDuplex === "auto" && !nativeBroken && nativeState("audio-worker") === "built";
  const output = native ? await backend.outputRoute() : undefined;
  if (output === "speakers") return "duck";
  return (await backend.detectDuplex(output)) === "full" ? "pause" : "none";
}

/** The audio worker, once every process recorder has exited; null, with a flight event, if it can't start. */
async function startWorker(): Promise<native.Worker | null> {
  await Promise.all(recorders); // a recorder running across the unit's start records at the wrong rate
  const t = Date.now();
  try {
    return await native.start();
  } catch (e) {
    flightEvent("audio.fallback", { ms: Date.now() - t }, null);
    log(`The audio worker couldn't start, so the call uses the recorder: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Open the mic for `purpose`: waits for it, or takes it from the work listener. */
export async function openAudio(opts: OpenOptions): Promise<AudioSession> {
  const routed = await route(opts.purpose); // before taking the mic, so a cancel meanwhile still ends the wait
  const mic = await claim(opts.purpose, opts);
  const worker = routed === "duck" ? await startWorker() : null;
  const interrupt: Interrupt = routed === "duck" && !worker ? "none" : routed; // native runs only on speakers
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
  const echo =
    opts.purpose === "call" ? () => muted || (worker ? worker.converging() : interrupt === "none" && replyAudible()) : () => false;

  let markEnded!: () => void;
  const ended = new Promise<void>((r) => (markEnded = r));
  let closing: Promise<void> | null = null;
  const close = () =>
    (closing ??= (async () => {
      ctl.abort();
      clearInterval(mute);
      if (liveWorker === worker) liveWorker = null;
      recording?.stop();
      await recording?.exited;
      await worker?.close();
      mic.release();
      markEnded();
    })());
  mic.preempted.addEventListener("abort", () => void close(), { once: true });
  if (worker) {
    liveWorker = worker;
    // A device change, a stalled mic or a crash ends the session; the caller opens a new one, on the process backend.
    worker.lost.addEventListener("abort", () => {
      const why = worker.lost.reason as native.WorkerLost;
      if (!why.routeChanged) nativeBroken = true;
      flightEvent("audio.lost", { routeChanged: why.routeChanged }, null);
      log(`The call's audio worker stopped: ${why.message}`);
      ctl.abort(why);
      void close();
    });
  }

  return {
    interrupt,
    signal: ctl.signal,
    ended,
    close,
    frames() {
      const recorder = worker ? null : backend.findRecorder();
      if (!worker && !recorder) throw new SetupError(backend.RECORDER_MISSING);
      if (!worker && liveWorker) throw new MicBusyError("A call is using the microphone.");
      if (recorder && !ctl.signal.aborted) {
        recording = backend.record(recorder);
        const exited = recording.exited;
        recorders.add(exited);
        void exited.then(() => recorders.delete(exited));
      }
      const inner = ctl.signal.aborted ? null : worker ? worker.frames : recording!.frames;
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
   * The built-in voice (macOS `say`, espeak-ng, Windows SAPI), each backend with one started ahead of
   * time: the process backend lets it play directly, which keeps its first sound quick; the native
   * backend has `say -o` render it to PCM.
   */
  | { kind: "voice"; text: string }
  /** A short sound file (a cue). */
  | { kind: "cue"; file: string; volume: number };

export type PlayEnd = "finished" | "stopped";

export interface Playback {
  /**
   * Settles once the player is gone: "finished", "stopped" after stop(), or rejects when the player
   * died or failed (or a speech source threw: the player is stopped at once).
   */
  readonly done: Promise<PlayEnd>;
  /** 1 = full volume. The native backend ramps to it over 10 ms; the process backend pauses below 1 and resumes at 1 (not on Windows). Idempotent. */
  duck(gain: number): void;
  /** Stop now, also while paused. Idempotent. */
  stop(): void;
  /** Milliseconds played so far: wall clock minus time paused, or what the native worker reports. */
  playedMs(): number;
}

/** Replies (speech, not cues) playing now, and when the last one stopped. */
let replies = 0;
let replyStoppedAt = -Infinity;
const replyAudible = () => replies > 0 || Date.now() - replyStoppedAt < ECHO_TAIL_MS;

/** Play a sound. Returns at once. */
export function play(sound: Sound): Playback {
  const playback = (liveWorker ?? backend).play(sound);
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
