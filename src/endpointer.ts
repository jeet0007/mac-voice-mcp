// Turn-taking without a model: an energy detector that adapts to room noise. See docs/specs/listening.md.

export const SAMPLE_RATE = 16000;
export const FRAME_MS = 30;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 480
export const FRAME_BYTES = FRAME_SAMPLES * 2; // 16-bit mono

export type EndReason = "end-of-turn" | "no-speech" | "max-duration";

export interface EndpointerOptions {
  maxMs: number;
  startTimeoutMs: number;
  endSilenceMs: number;
  /** dB above the tracked noise floor. */
  marginDb: number;
  /** dBFS. */
  minSpeechDb: number;
}

const ONSET_FRAMES = 4;
const MIN_UTTERANCE_MS = 210; // 7 whole frames: a 150 ms cough can light 6
const SETTLE_FRAMES = 3;
const FLOOR_WINDOW_FRAMES = 50;
const FLOOR_CEILING_BELOW_SPEECH_DB = 24;
const OVER_CHIME_SLACK_FRAMES = 5;
const OVER_CHIME_GAP_FRAMES = 10;
const BELOW_VOICE_DB = 18;
const REBASE_MIN_FRAMES = 17;
const STEADY_SPREAD_DB = 2.5;
const STEADY_BELOW_SPEECH_DB = 6;

export interface EndpointerDiagnostics {
  floorDb: number;
  /** NaN before any speech. */
  speechDb: number;
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
  private readonly hardCapFrames: number;
  private readonly startTimeoutFrames: number;
  private readonly endSilenceFrames: number;
  private readonly historySize: number;

  private history: number[] = [];
  private floorDb = -90;
  private speechDb = Number.NaN;
  private frames = 0;
  private loudRun = 0;
  private quietRun = 0;
  private voicedFrames = 0;
  private started = false;
  private everStarted = false;
  private belowVoiceFrames = 0;
  private belowVoiceSumDb = 0;

  /** -1 until speech starts. */
  speechStartFrame = -1;
  /** -1 until speech starts. */
  lastVoicedFrame = -1;
  anyNonZero = false;
  lastDb = -100;
  lastThresholdDb = Number.NaN;
  private ignoring = false;
  private ignoredUntil = -1;
  private ignoredLoudFrom = -1;
  private ignoredQuietRun = 0;

  constructor(private readonly opts: EndpointerOptions) {
    this.maxFrames = Math.ceil(opts.maxMs / FRAME_MS);
    this.startTimeoutFrames = Math.ceil(Math.min(opts.startTimeoutMs, opts.maxMs) / FRAME_MS);
    this.hardCapFrames = this.startTimeoutFrames + this.maxFrames;
    this.endSilenceFrames = Math.ceil(opts.endSilenceMs / FRAME_MS);
    this.historySize = Math.max(FLOOR_WINDOW_FRAMES, this.endSilenceFrames, Math.ceil(1000 / FRAME_MS));
  }

  /** Ignored frames still count towards the time limits. */
  setIgnoring(on: boolean): void {
    if (on && !this.ignoring) {
      this.ignoredLoudFrom = -1;
      this.ignoredQuietRun = 0;
    }
    if (!on && this.ignoring) this.ignoredUntil = this.frames;
    this.ignoring = on;
    if (on && !this.started) this.loudRun = 0;
  }

  /** One 30 ms frame of 16-bit little-endian PCM. */
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
    this.lastDb = db;
    const idx = this.frames++;
    if (this.ignoring) {
      const loud = db > Math.max(this.floorDb + this.opts.marginDb, this.opts.minSpeechDb) && idx >= SETTLE_FRAMES;
      if (loud) {
        this.ignoredQuietRun = 0;
        if (this.ignoredLoudFrom < 0) this.ignoredLoudFrom = idx;
      } else if (++this.ignoredQuietRun >= OVER_CHIME_GAP_FRAMES) this.ignoredLoudFrom = -1;
      return this.timeLimit();
    }

    if (idx >= SETTLE_FRAMES) {
      this.history.push(db);
      if (this.history.length > this.historySize) this.history.shift();
    }

    if (this.history.length) {
      this.floorDb = Math.min(-30, Math.max(-90, Math.min(...this.history.slice(-FLOOR_WINDOW_FRAMES))));
      if (this.started && !Number.isNaN(this.speechDb)) {
        this.floorDb = Math.min(this.floorDb, this.speechDb - FLOOR_CEILING_BELOW_SPEECH_DB);
      }
    }
    const threshold = Math.max(this.floorDb + this.opts.marginDb, this.opts.minSpeechDb);
    this.lastThresholdDb = threshold;
    const aboveThreshold = db > threshold && idx >= SETTLE_FRAMES;
    let loud = aboveThreshold;
    if (aboveThreshold && this.started && db < this.speechDb - BELOW_VOICE_DB) {
      this.belowVoiceFrames++;
      this.belowVoiceSumDb += db;
      if (this.belowVoiceFrames >= Math.max(REBASE_MIN_FRAMES, this.voicedFrames)) {
        this.speechDb = this.belowVoiceSumDb / this.belowVoiceFrames; // the quieter sound is the voice
        this.voicedFrames += this.belowVoiceFrames - 1; // counted as voiced from here (this frame is added below)
      } else {
        loud = false;
      }
    }
    if (loud) {
      this.belowVoiceFrames = 0;
      this.belowVoiceSumDb = 0;
    }

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
        if (this.ignoredUntil >= 0 && this.ignoredLoudFrom >= 0 && this.speechStartFrame - this.ignoredUntil <= OVER_CHIME_SLACK_FRAMES) {
          this.speechStartFrame = this.ignoredLoudFrom; // the user talked over the chime
        }
        this.voicedFrames = this.loudRun;
        this.lastVoicedFrame = idx;
        this.speechDb = Number.isNaN(this.speechDb) ? db : this.speechDb;
      }
    } else {
      this.loudRun = 0;
      this.quietRun++;
    }

    if (this.started) {
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
          this.started = false;
          this.everStarted = false;
          this.voicedFrames = 0;
          this.speechStartFrame = -1;
          this.lastVoicedFrame = -1;
          this.speechDb = Number.NaN;
          this.belowVoiceFrames = 0;
          this.belowVoiceSumDb = 0;
        } else {
          return "end-of-turn";
        }
      }
    }

    return this.timeLimit();
  }

  private timeLimit(): EndReason | null {
    if (this.everStarted) {
      const talked = this.speechStartFrame >= 0 ? this.frames - this.speechStartFrame : 0;
      if (talked >= this.maxFrames || this.frames >= this.hardCapFrames) return "max-duration";
      return null;
    }
    if (this.frames >= this.startTimeoutFrames) return "no-speech";
    return null;
  }

  diagnostics(): EndpointerDiagnostics {
    const [recentDb, recentSpreadDb] = meanStd(this.history.slice(-Math.ceil(1000 / FRAME_MS)));
    return { floorDb: this.floorDb, speechDb: this.speechDb, recentDb, recentSpreadDb };
  }

  get quietMs(): number {
    return this.quietRun * FRAME_MS;
  }

  get speaking(): boolean {
    return this.started;
  }

  get speechSeconds(): number {
    return (this.voicedFrames * FRAME_MS) / 1000;
  }

  trimRange(totalFrames: number, padMs = 300): [number, number] {
    const pad = Math.round(padMs / FRAME_MS);
    const first = this.speechStartFrame >= 0 ? Math.max(0, this.speechStartFrame - pad) : 0;
    const last = this.lastVoicedFrame >= 0 ? Math.min(totalFrames, this.lastVoicedFrame + 1 + pad) : totalFrames;
    return [first, last];
  }
}

export function wavHeader(dataBytes: number, sampleRate = SAMPLE_RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(dataBytes, 40);
  return h;
}
