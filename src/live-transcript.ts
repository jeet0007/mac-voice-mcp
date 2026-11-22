// Schedules the call's partial transcripts and word checks against the warm whisper-server. See docs/specs/live-transcript.md.
import { FRAME_MS } from "./endpointer.js";

export const MIN_SPEECH_S = 0.5;
export const MAX_QUIET_MS = 300;
export const MAX_AUDIO_MS = 30_000;

export interface LiveOptions {
  request: (wav: Buffer, signal: AbortSignal) => Promise<string | null>;
  emit: (text: string) => void;
  enabled: () => boolean;
  ready: () => boolean;
  everyMs: number;
}

export interface LiveStats {
  requests: number;
  requestMs: number;
}

export class LiveTranscript {
  private audioMs = 0;
  private lastAskAt = -Infinity;
  private inFlight: AbortController | null = null;
  private epoch = 0;
  private lastText = "";
  private waiting: ((text: string | null) => void)[] = [];
  private riding: ((text: string | null) => void)[] = [];
  quietMs = 0;
  readonly stats: LiveStats = { requests: 0, requestMs: 0 };

  constructor(private readonly opts: LiveOptions) {}

  // `audio` is called only when a request goes out.
  frame(speechSeconds: number, quietMs: number, audio: () => Buffer): void {
    this.audioMs += FRAME_MS;
    this.quietMs = quietMs;
    if (this.inFlight) return;
    if (this.waiting.length) {
      if (this.opts.ready()) this.ask(audio);
      return;
    }
    if (speechSeconds < MIN_SPEECH_S || quietMs >= MAX_QUIET_MS) return;
    if (this.audioMs - this.lastAskAt < this.opts.everyMs) return;
    if (this.opts.enabled()) this.ask(audio);
  }

  // Unlike the panel's audio-time schedule, `startMs` is wall-clock time.
  check(startMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      if (this.inFlight) return void this.riding.push(resolve);
      this.waiting.push(resolve);
      setTimeout(() => {
        const i = this.waiting.indexOf(resolve);
        if (i < 0) return;
        this.waiting.splice(i, 1);
        resolve(null);
      }, startMs).unref();
    });
  }

  private ask(audio: () => Buffer): void {
    this.lastAskAt = this.audioMs;
    this.riding.push(...this.waiting.splice(0));
    const ctl = new AbortController();
    this.inFlight = ctl;
    const epoch = this.epoch;
    const started = Date.now();
    this.stats.requests++;
    this.opts.request(audio(), ctl.signal).then(
      (text) => this.done(ctl, epoch, started, text),
      () => this.done(ctl, epoch, started, null),
    );
  }

  private done(ctl: AbortController, epoch: number, started: number, text: string | null): void {
    if (this.inFlight === ctl) {
      this.inFlight = null;
      for (const answer of this.riding.splice(0)) answer(text);
    }
    this.stats.requestMs += Date.now() - started;
    if (epoch !== this.epoch || ctl.signal.aborted || !text) return;
    const clean = text.trim();
    if (!clean || clean === this.lastText) return;
    this.lastText = clean;
    this.opts.emit(clean);
  }

  end(): void {
    this.epoch++;
    this.lastText = "";
    this.lastAskAt = -Infinity;
    this.inFlight?.abort();
    this.inFlight = null;
    for (const answer of [...this.waiting.splice(0), ...this.riding.splice(0)]) answer(null);
  }
}

export function utteranceFrames(frames: Buffer[], speechStartFrame: number, padFrames = 10): Buffer[] {
  const first = Math.max(0, speechStartFrame - padFrames, frames.length - Math.floor(MAX_AUDIO_MS / FRAME_MS));
  return frames.slice(first);
}
