/**
 * Turn-taking without a model (pure, unit-tested): an energy-based voice-activity
 * detector that adapts to the room's background noise.
 *
 *   - waits for speech (≥120 ms above threshold) for up to `startTimeoutMs`
 *   - once speaking, ends the turn after `endSilenceMs` of quiet
 *   - ignores blips shorter than 300 ms (a cough, a click) and keeps listening
 *   - hard stop at `maxMs`
 */

export const SAMPLE_RATE = 16000;
export const FRAME_MS = 30;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 480
export const FRAME_BYTES = FRAME_SAMPLES * 2; // 16-bit mono

/** Why listening stopped. */
export type EndReason = "end-of-turn" | "no-speech" | "max-duration";

export interface EndpointerOptions {
  maxMs: number;
  startTimeoutMs: number;
  endSilenceMs: number;
  /** Speech must be this many dB above the tracked noise floor. */
  marginDb: number;
  /** …and at least this loud (dBFS). */
  minSpeechDb: number;
}

const ONSET_FRAMES = 4; // 120 ms of sound before we believe it's speech
const MIN_UTTERANCE_MS = 300; // shorter bursts are treated as noise
const SETTLE_FRAMES = 3; // ignore the first 90 ms while the mic settles
const FLOOR_WINDOW_FRAMES = 50; // background level = quietest frame of the last 1.5 s
const STEADY_SPREAD_DB = 2.5; // sound this steady for a whole end-silence window is noise, not speech
const STEADY_BELOW_SPEECH_DB = 6; // …as long as it's also clearly quieter than the user's voice

export interface EndpointerDiagnostics {
  /** Background level (dBFS) at the last frame. */
  floorDb: number;
  /** Typical level of the user's voice (dBFS), NaN before any speech. */
  speechDb: number;
  /** Mean and spread (standard deviation) of the last second, in dB. */
  recentDb: number;
  recentSpreadDb: number;
}

function meanStd(values: number[]): [number, number] {
  if (!values.length) return [Number.NaN, Number.NaN];
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return [mean, Math.sqrt(variance)];
}

export class Endpointer {
  private readonly maxFrames: number;
  private readonly startTimeoutFrames: number;
  private readonly endSilenceFrames: number;
  private readonly historySize: number;

  /** Recent frame levels in dB, newest last. */
  private history: number[] = [];
  private floorDb = -90;
  private speechDb = Number.NaN;
  private frames = 0;
  private loudRun = 0;
  private quietRun = 0;
  private voicedFrames = 0;
  private started = false;
  private everStarted = false;

  /** Frame index where the current utterance began (-1 = none yet). */
  speechStartFrame = -1;
  /** Frame index of the last voiced frame (-1 = none yet). */
  lastVoicedFrame = -1;
  /** False while every sample so far has been exactly zero (a blocked mic). */
  anyNonZero = false;

  constructor(private readonly opts: EndpointerOptions) {
    this.maxFrames = Math.ceil(opts.maxMs / FRAME_MS);
    this.startTimeoutFrames = Math.ceil(Math.min(opts.startTimeoutMs, opts.maxMs) / FRAME_MS);
    this.endSilenceFrames = Math.ceil(opts.endSilenceMs / FRAME_MS);
    this.historySize = Math.max(FLOOR_WINDOW_FRAMES, this.endSilenceFrames, Math.ceil(1000 / FRAME_MS));
  }

  /** Feed one 30 ms frame of 16-bit little-endian PCM; returns a reason once the turn is over. */
  push(frame: Uint8Array): EndReason | null {
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    let sumSq = 0;
    const n = frame.byteLength >> 1;
    for (let i = 0; i < n; i++) {
      const v = view.getInt16(i * 2, true);
      if (v !== 0) this.anyNonZero = true;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, n)) / 32768;
    const db = Math.max(-100, 20 * Math.log10(rms + 1e-9));
    const idx = this.frames++;

    if (idx >= SETTLE_FRAMES) {
      this.history.push(db);
      if (this.history.length > this.historySize) this.history.shift();
    }

    // Background level = the quietest frame of the last 1.5 s. Because it keeps
    // updating while the user talks (the gaps between words are quiet), it follows
    // a room that gets louder — a fan, or a laptop mic's automatic gain boosting the
    // noise after speech — as well as one that gets quieter.
    if (this.history.length) {
      this.floorDb = Math.min(-30, Math.max(-90, Math.min(...this.history.slice(-FLOOR_WINDOW_FRAMES))));
    }
    const threshold = Math.max(this.floorDb + this.opts.marginDb, this.opts.minSpeechDb);
    const loud = db > threshold && idx >= SETTLE_FRAMES;

    if (loud) {
      this.loudRun++;
      this.quietRun = 0;
      if (this.started) {
        this.voicedFrames++;
        this.lastVoicedFrame = idx;
        this.speechDb = 0.9 * this.speechDb + 0.1 * db;
      } else if (this.loudRun >= ONSET_FRAMES) {
        this.started = true;
        this.everStarted = true;
        this.speechStartFrame = idx - this.loudRun + 1;
        this.voicedFrames = this.loudRun;
        this.lastVoicedFrame = idx;
        this.speechDb = Number.isNaN(this.speechDb) ? db : this.speechDb;
      }
    } else {
      this.loudRun = 0;
      this.quietRun++;
    }

    if (this.started) {
      // End of turn: a stretch of quiet, or a stretch of steady sound clearly below
      // the voice (speech rises and falls with every syllable; background noise doesn't).
      let ended = this.quietRun >= this.endSilenceFrames;
      if (!ended && this.history.length >= this.endSilenceFrames) {
        const [mean, spread] = meanStd(this.history.slice(-this.endSilenceFrames));
        if (spread < STEADY_SPREAD_DB && mean < this.speechDb - STEADY_BELOW_SPEECH_DB) {
          ended = true;
          this.lastVoicedFrame = Math.max(this.speechStartFrame, idx - this.endSilenceFrames);
          this.voicedFrames = Math.max(0, this.voicedFrames - this.endSilenceFrames + this.quietRun);
        }
      }
      if (ended) {
        if (this.voicedFrames * FRAME_MS < MIN_UTTERANCE_MS) {
          // Too short to be an answer (cough, click, chair). Keep waiting.
          this.started = false;
          this.everStarted = false;
          this.voicedFrames = 0;
          this.speechStartFrame = -1;
          this.lastVoicedFrame = -1;
          this.speechDb = Number.NaN;
        } else {
          return "end-of-turn";
        }
      }
    }

    if (this.frames >= this.maxFrames) return this.everStarted ? "max-duration" : "no-speech";
    if (!this.everStarted && this.frames >= this.startTimeoutFrames) return "no-speech";
    return null;
  }

  /** Levels behind the last decision — reported when listening hits its time limit, to help tuning. */
  diagnostics(): EndpointerDiagnostics {
    const [recentDb, recentSpreadDb] = meanStd(this.history.slice(-Math.ceil(1000 / FRAME_MS)));
    return { floorDb: this.floorDb, speechDb: this.speechDb, recentDb, recentSpreadDb };
  }

  get speechSeconds(): number {
    return (this.voicedFrames * FRAME_MS) / 1000;
  }

  /** Frame range worth transcribing: the utterance plus `padMs` either side. */
  trimRange(totalFrames: number, padMs = 300): [number, number] {
    const pad = Math.round(padMs / FRAME_MS);
    const first = this.speechStartFrame >= 0 ? Math.max(0, this.speechStartFrame - pad) : 0;
    const last = this.lastVoicedFrame >= 0 ? Math.min(totalFrames, this.lastVoicedFrame + 1 + pad) : totalFrames;
    return [first, last];
  }
}

/** 44-byte header for 16 kHz mono 16-bit PCM WAV. */
export function wavHeader(dataBytes: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(dataBytes, 40);
  return h;
}
