/**
 * The one frame loop: mic frames → Endpointer → what the user said. A turn listens for one
 * utterance; a call cuts its open mic into utterance after utterance until the session closes.
 * The audio stays in memory: each utterance comes back as a trimmed 16 kHz mono WAV, leading and
 * trailing silence cut (keeping a little padding) so whisper gets just the utterance.
 */
import { MIC_PERMISSION_HINT, type AudioSession, type Frame } from "../audio/device.js";
import { CONFIG, IS_MAC } from "../config.js";
import { Endpointer, FRAME_MS, wavHeader, type EndReason, type EndpointerDiagnostics } from "../endpointer.js";
import { flightAudio, flightEvent } from "../flight.js";
import { utteranceFrames, type LiveTranscript } from "../live-transcript.js";
import { CancelledError } from "../proc.js";

/** Speech this long is the user talking (over Claude, say): Pipecat waits 200 ms, LiveKit 500 ms; 150 ms is too eager. */
export const BARGE_IN_MS = 250;
/** Audio the mic must have delivered before we tell the user it's open: the recorder is running, and the room's level is known. */
export const MIC_WARMUP_MS = 250;
/** One utterance on a call is at most this long; after this much silence the endpointer starts afresh, so nothing piles up. */
const UTTERANCE_MAX_MS = 60_000;

/** "cut": the mic stopped hearing the user mid-sentence (our reply on speakers, or mute). */
export type Ending = EndReason | "cut";

export type Heard =
  /** The user has talked for BARGE_IN_MS. */
  | { kind: "onset" }
  /** An utterance, after its onset or ended by the endpointer. */
  | { kind: "ended"; reason: Exclude<Ending, "no-speech">; wav: Buffer }
  /** Speech cut before its onset: too short to count, dropped. */
  | { kind: "blip" }
  /** Nothing said before the start timeout. */
  | { kind: "no-speech" };

export interface UtteranceOptions {
  onHeard?: (heard: Heard) => void;
  /** Each heard frame's level and the speech threshold it was judged against, in dBFS. */
  onLevel?: (db: number, thresholdDb: number) => void;
  /** Gets every heard frame while the user talks, to ask for rough transcripts (src/live-transcript.ts). */
  live?: LiveTranscript;
}

const toWav = (frames: Buffer[]): Buffer => {
  const pcm = Buffer.concat(frames);
  return Buffer.concat([wavHeader(pcm.length), pcm]);
};

/** Frames → utterances. `echo` frames are never judged or kept: the first one ends what the user was saying. */
export class Utterances {
  endpointer: Endpointer;
  /** Heard frames of the utterance so far. */
  frames: Buffer[] = [];
  private onset = false;

  constructor(
    private readonly fresh: () => Endpointer,
    private readonly o: UtteranceOptions = {},
  ) {
    this.endpointer = fresh();
  }

  /** Judge one frame. Returns how the utterance ended, if it did; reset() before the next one. */
  push({ pcm, echo }: Frame): Ending | null {
    const e = this.endpointer;
    if (echo) {
      if (!this.frames.length) return null;
      // Unheard from here on, so what was said so far is all there is: ended, or dropped if too short.
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

  /** The utterance so far, trimmed. */
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
  /** The microphone delivered nothing but exact zeros — almost always a permission block. */
  digitalSilence: boolean;
  /** Seconds of voiced audio detected. */
  speechSeconds: number;
  /** Audio levels behind the decision, for tuning. */
  levels: EndpointerDiagnostics;
  /** The trimmed utterance as a complete 16 kHz mono WAV. */
  wav: Buffer;
}

export interface TurnOptions {
  /** Stops listening: the turn throws CancelledError. */
  signal?: AbortSignal;
  /**
   * Called once the microphone is really recording (after MIC_WARMUP_MS of audio), to tell the
   * user to talk — the "mic open" chime. While its promise is pending, the sound it makes is ignored.
   */
  onListening?: () => Promise<unknown> | void;
}

/**
 * Listen for one conversational turn on `session`, stopping the recorder the moment the user
 * finishes (without waiting for it to exit: session.close() does). The recorder starts first and
 * the chime comes only once audio is flowing, so someone who starts talking right at the chime is
 * never cut off: opening a mic takes a moment, longer with Bluetooth.
 */
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

/**
 * Cut `session`'s open mic into utterances until it closes, each with a fresh Endpointer and no
 * start timeout, so silence never ends it. Rejects if the mic stops on its own.
 */
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
