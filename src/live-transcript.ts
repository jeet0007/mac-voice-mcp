/**
 * Live transcript (docs/specs/live-transcript.md): while the user talks on a call, ask the warm
 * whisper-server for a rough transcript of the utterance so far, about every 700 ms, and hand each
 * new one to `emit` (the call bubble's panel). Pure scheduling, unit-tested with a fake clock-less
 * feed: time is the audio's own (30 ms a frame), so a recorder that delivers in bursts behaves the same.
 *
 * The call's word check (talking over a reply on the native backend) shares the same requests:
 * one partial stream per utterance, since whisper serves one request at a time.
 *
 * Partial words are display only, or a yes/no for the word check. They live in memory here and in
 * the bubble, and nowhere else: not the inbox, not a result, not a log, not a file.
 */
import { FRAME_MS } from "./endpointer.js";

/** Less speech than this isn't worth a request. */
export const MIN_SPEECH_S = 0.5;
/** The utterance is probably ending when the last this-many ms were quiet: nothing new to show, and the final must not queue behind a partial. */
export const MAX_QUIET_MS = 300;
/** Never more audio than this goes in a request (the tail of a long utterance). */
export const MAX_AUDIO_MS = 30_000;

export interface LiveOptions {
  /** Ask for a transcript of `wav`; null: can't (no warm server, failed, aborted). */
  request: (wav: Buffer, signal: AbortSignal) => Promise<string | null>;
  /** A new, non-empty partial that is still the newest. */
  emit: (text: string) => void;
  /** Checked before every request: switch on, bubble taking text, server warm. */
  enabled: () => boolean;
  /** A word check's request can go out now: the server is warm and not busy with a final transcript. */
  ready: () => boolean;
  everyMs: number;
}

export interface LiveStats {
  requests: number;
  /** Total time spent waiting on requests, ms. */
  requestMs: number;
}

export class LiveTranscript {
  private audioMs = 0;
  private lastAskAt = -Infinity;
  private inFlight: AbortController | null = null;
  /** Bumped at every utterance end: a reply from an earlier one is stale. */
  private epoch = 0;
  private lastText = "";
  /** Word checks waiting for a request to go out, and those the request in flight will answer. */
  private waiting: ((text: string | null) => void)[] = [];
  private riding: ((text: string | null) => void)[] = [];
  /** How long the user had been quiet at the last frame, in ms. */
  quietMs = 0;
  readonly stats: LiveStats = { requests: 0, requestMs: 0 };

  constructor(private readonly opts: LiveOptions) {}

  /**
   * One 30 ms frame has been heard. `speechSeconds` and `quietMs` come from the endpointer;
   * `audio` builds the request's PCM (the utterance so far) and is called only when a request goes out.
   */
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

  /**
   * The utterance so far as text, for the word check: the request in flight answers it, or the next
   * frame sends one. null when none could go out within `startMs` (cold or busy server, the
   * utterance ended) or it failed. Unlike the panel's, this deadline is wall-clock time.
   */
  check(startMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      if (this.inFlight) return void this.riding.push(resolve);
      this.waiting.push(resolve);
      setTimeout(() => {
        const i = this.waiting.indexOf(resolve);
        if (i < 0) return;
        this.waiting.splice(i, 1);
        resolve(null);
      }, startMs);
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
    if (epoch !== this.epoch || ctl.signal.aborted || !text) return; // stale, or nothing heard
    const clean = text.trim();
    if (!clean || clean === this.lastText) return;
    this.lastText = clean;
    this.opts.emit(clean);
  }

  /** The utterance is over (or was cut): ignore and cancel any request still out, and start fresh. */
  end(): void {
    this.epoch++;
    this.lastText = "";
    this.lastAskAt = -Infinity;
    this.inFlight?.abort();
    this.inFlight = null;
    for (const answer of [...this.waiting.splice(0), ...this.riding.splice(0)]) answer(null);
  }
}

/** The last `MAX_AUDIO_MS` of an utterance's frames, from a little before the speech began. */
export function utteranceFrames(frames: Buffer[], speechStartFrame: number, padFrames = 10): Buffer[] {
  const first = Math.max(0, speechStartFrame - padFrames, frames.length - Math.floor(MAX_AUDIO_MS / FRAME_MS));
  return frames.slice(first);
}
