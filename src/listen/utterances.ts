// The one frame loop: mic frames through the Endpointer into utterances, for a turn or a call. See docs/specs/listening.md.
import { MIC_PERMISSION_HINT, type AudioSession, type Frame } from "../audio/device.js";
import { CONFIG, IS_MAC } from "../config.js";
import { Endpointer, FRAME_MS, wavHeader, type EndReason, type EndpointerDiagnostics } from "../endpointer.js";
import { flightAudio, flightEvent } from "../flight.js";
import { utteranceFrames, type LiveTranscript } from "../live-transcript.js";
import { CancelledError } from "../proc.js";

export const BARGE_IN_MS = 250;
export const MIC_WARMUP_MS = 250;
const UTTERANCE_MAX_MS = 60_000;

export type Ending = EndReason | "cut";

export type Heard =
  | { kind: "onset" }
  | { kind: "ended"; reason: Exclude<Ending, "no-speech">; wav: Buffer }
  | { kind: "blip" }
  | { kind: "no-speech" };

export interface UtteranceOptions {
  onHeard?: (heard: Heard) => void;
  /** dBFS. */
  onLevel?: (db: number, thresholdDb: number) => void;
  live?: LiveTranscript;
}

const toWav = (frames: Buffer[]): Buffer => {
  const pcm = Buffer.concat(frames);
  return Buffer.concat([wavHeader(pcm.length), pcm]);
};

export class Utterances {
  endpointer: Endpointer;
  frames: Buffer[] = [];
  private onset = false;

  constructor(
    private readonly fresh: () => Endpointer,
    private readonly o: UtteranceOptions = {},
  ) {
    this.endpointer = fresh();
  }

  // Call reset() after an ending, before the next utterance.
  push({ pcm, echo }: Frame): Ending | null {
    const e = this.endpointer;
    if (echo) {
      if (!this.frames.length) return null;
      if (this.onset) return this.end("cut");
      if (e.speaking) {
        flightEvent("listen.cut", { speechMs: Math.round(e.speechSeconds * 1000) }, null);
        this.o.onHeard?.({ kind: "blip" });
      }
      this.o.live?.end();
      this.reset();
      return null;
    }
    this.frames.push(pcm);
    flightAudio(pcm);
    const reason = e.push(pcm);
    this.o.onLevel?.(e.lastDb, e.lastThresholdDb);
    if (reason) return this.end(reason);
    if (this.o.live && e.speaking) this.o.live.frame(e.speechSeconds, e.quietMs, () => toWav(utteranceFrames(this.frames, e.speechStartFrame)));
    if (!this.onset && e.speechSeconds * 1000 >= BARGE_IN_MS) {
      this.onset = true;
      this.o.onHeard?.({ kind: "onset" });
    }
    return null;
  }

  wav(): Buffer {
    const [first, last] = this.endpointer.trimRange(this.frames.length);
    return toWav(this.frames.slice(first, last));
  }

  reset(): void {
    this.endpointer = this.fresh();
    this.frames = [];
    this.onset = false;
  }

  private end(reason: Ending): Ending {
    this.o.live?.end(); // before the utterance: a partial still out is dropped, the final goes alone
    this.o.onHeard?.(reason === "no-speech" ? { kind: "no-speech" } : { kind: "ended", reason, wav: this.wav() });
    return reason;
  }
}

const endpointer = (maxMs: number, startTimeoutMs: number) =>
  new Endpointer({ maxMs, startTimeoutMs, endSilenceMs: CONFIG.endSilenceMs, marginDb: CONFIG.speechMarginDb, minSpeechDb: CONFIG.minSpeechDb });

export interface Turn {
  reason: Ending;
  digitalSilence: boolean;
  speechSeconds: number;
  levels: EndpointerDiagnostics;
  wav: Buffer;
}

export interface TurnOptions {
  /** Aborting makes the turn throw CancelledError. */
  signal?: AbortSignal;
  /** Plays the "mic open" chime; the mic is ignored while its promise is pending. */
  onListening?: () => Promise<unknown> | void;
}

export async function listenForTurn(session: AudioSession, maxSeconds: number, opts: TurnOptions = {}): Promise<Turn> {
  const cut = new Utterances(() => endpointer(maxSeconds * 1000, CONFIG.startTimeoutSeconds * 1000));
  const warmupFrames = Math.ceil(MIC_WARMUP_MS / FRAME_MS);
  let announced = false;
  const announce = () => {
    announced = true;
    if (!opts.onListening) return;
    const e = cut.endpointer;
    e.setIgnoring(true);
    Promise.resolve()
      .then(opts.onListening)
      .catch(() => {})
      // A short tail: the chime's echo fades out of the mic a moment after it ends.
      .finally(() => setTimeout(() => e.setIgnoring(false), 80));
  };

  const frames = session.frames();
  const stop = () => void frames.return?.();
  // Wait for speech + talking time + slack: a recorder that stops delivering audio still ends the turn.
  const safety = setTimeout(stop, (Math.min(CONFIG.startTimeoutSeconds, maxSeconds) + maxSeconds + 5) * 1000);
  opts.signal?.addEventListener("abort", stop, { once: true });
  const listenedAt = Date.now();
  flightEvent("listen.start", {
    mode: "turn",
    maxMs: maxSeconds * 1000,
    endSilenceMs: CONFIG.endSilenceMs,
    marginDb: CONFIG.speechMarginDb,
    minSpeechDb: CONFIG.minSpeechDb,
    chime: !!opts.onListening && CONFIG.chime,
  });
  const ended = (why: string) =>
    flightEvent("listen.end", { reason: why, totalMs: Date.now() - listenedAt, speechMs: Math.round(cut.endpointer.speechSeconds * 1000), ...cut.endpointer.diagnostics() });

  let reason: Ending | null = null;
  let failure: unknown = null;
  try {
    for await (const frame of frames) {
      reason = cut.push(frame);
      if (!announced && cut.frames.length >= warmupFrames) announce();
      if (reason) break;
    }
  } catch (err) {
    failure = err; // the recorder stopped on its own: what it heard so far is the turn
  } finally {
    clearTimeout(safety);
    opts.signal?.removeEventListener("abort", stop);
  }
  if (opts.signal?.aborted) {
    ended("stopped");
    throw new CancelledError();
  }
  if (!cut.frames.length) {
    ended("error");
    throw failure ?? new Error(`Recording failed: the microphone delivered no audio.${IS_MAC ? ` ${MIC_PERMISSION_HINT}` : ""}`);
  }
  ended(reason ?? "max-duration");
  return {
    reason: reason ?? "max-duration",
    digitalSilence: !cut.endpointer.anyNonZero,
    speechSeconds: cut.endpointer.speechSeconds,
    levels: cut.endpointer.diagnostics(),
    wav: cut.wav(),
  };
}

/** Runs until the session closes; rejects if the mic stops on its own. */
export async function listenContinuously(session: AudioSession, opts: UtteranceOptions): Promise<void> {
  const cut = new Utterances(() => endpointer(UTTERANCE_MAX_MS, UTTERANCE_MAX_MS), opts);
  flightEvent("listen.start", { mode: "call", maxMs: UTTERANCE_MAX_MS, endSilenceMs: CONFIG.endSilenceMs, marginDb: CONFIG.speechMarginDb, minSpeechDb: CONFIG.minSpeechDb, chime: false }, null);
  for await (const frame of session.frames()) {
    const reason = cut.push(frame);
    if (!reason) continue;
    const e = cut.endpointer;
    flightEvent("listen.end", { mode: "call", reason, totalMs: cut.frames.length * FRAME_MS, speechMs: Math.round(e.speechSeconds * 1000), ...e.diagnostics() }, null);
    cut.reset();
  }
}
