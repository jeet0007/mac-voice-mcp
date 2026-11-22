// The audio port: every session that hears sound and every sound played goes through here. See docs/specs/audio.md.
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

export interface Frame {
  readonly pcm: Buffer;
  // The user can't be heard in it: neither judge it as speech nor keep it.
  readonly echo: boolean;
}

export type Purpose = "turn" | "call" | "worklisten" | "doctor";

export type Interrupt = "duck" | "pause" | "none";

export interface OpenOptions {
  purpose: Purpose;
  signal?: AbortSignal;
  onWait?: () => void;
}

export interface AudioSession {
  readonly interrupt: Interrupt;
  // Call once: the recorder starts here.
  frames(): AsyncIterableIterator<Frame>;
  readonly signal: AbortSignal;
  readonly ended: Promise<void>;
  close(): Promise<void>;
}

const ECHO_TAIL_MS = 300;
const MUTE_POLL_MS = 250;

let nativeBroken = false;
let liveWorker: native.Worker | null = null;
let workerStarting = false;
const recorders = new Set<Promise<void>>();

async function route(purpose: Purpose): Promise<Interrupt> {
  if (purpose !== "call") return "none";
  const useNative = CONFIG.audio === "native" && IS_MACOS_15 && CONFIG.callDuplex === "auto" && !nativeBroken && nativeState("audio-worker") === "built";
  const output = useNative ? await backend.outputRoute() : undefined;
  if (output === "speakers") return "duck";
  return (await backend.detectDuplex(output)) === "full" ? "pause" : "none";
}

export async function describeCallAudio(): Promise<string> {
  const interrupt = await route("call");
  if (interrupt === "duck") return "native: the echo-cancelled audio worker, so the user can talk over Claude";
  return `process: the recorder, ${interrupt === "pause" ? "and a reply pauses when the user talks (headphones)" : "with the mic muted while Claude speaks"}`;
}

async function startWorker(): Promise<native.Worker | null> {
  workerStarting = true;
  await Promise.all(recorders); // a recorder running across the unit's start records at the wrong rate
  const t = Date.now();
  try {
    return await native.start();
  } catch (e) {
    nativeBroken = true; // a mic prompt left unanswered would otherwise stall every call by the start timeout
    flightEvent("audio.fallback", { ms: Date.now() - t }, null);
    log(`The audio worker couldn't start, so the call uses the recorder: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    workerStarting = false;
  }
}

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
      if (!worker && (liveWorker || workerStarting)) throw new MicBusyError("A call is using the microphone.");
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

// 24 kHz mono s16le.
export const SPEECH_RATE = 24_000;

export type Sound =
  | { kind: "speech"; chunks: AsyncIterable<Buffer> }
  | { kind: "voice"; text: string }
  | { kind: "cue"; file: string; volume: number };

export type PlayEnd = "finished" | "stopped";

export interface Playback {
  // Rejects when the player died or failed, or a speech source threw.
  readonly done: Promise<PlayEnd>;
  // 1 = full volume.
  duck(gain: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
  playedMs(): number;
}

let replies = 0;
let replyStoppedAt = -Infinity;
const replyAudible = () => replies > 0 || Date.now() - replyStoppedAt < ECHO_TAIL_MS;

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
