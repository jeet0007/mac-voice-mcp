/**
 * Talking over Claude on a call (full duplex, headphones): speech pauses the reply, real words drop
 * the rest of it, and a filler ("mm-hm"), a cough or nothing real within BARGE_IN_WAIT_MS resumes it.
 * The call reports what it plays and hears; pausing goes through `pause`, so this holds no processes.
 */

/** After talking over Claude, nothing real said within this long resumes the reply (LiveKit's 2 s). */
export const BARGE_IN_WAIT_MS = 2000;
/** About how fast the voices speak, to tell Claude how much of a reply was heard. */
const WORDS_PER_SECOND = 2.7;

const FILLERS = new Set(["mm", "mmm", "hmm", "mhm", "mm-hmm", "mm-hm", "uh-huh", "uh", "um", "ah", "oh", "okay", "ok", "yeah", "yep", "right", "sure"]);

/**
 * Is this only backchannel ("Mm-hmm.", "Yeah, okay."), or nothing at all? Then talking over Claude
 * doesn't cut its reply. Sound tags whisper adds ("[BLANK_AUDIO]", "(coughs)") don't count as words.
 */
export function isFiller(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/[^\p{L}\p{N}'\- ]+/gu, " ")
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.every((w) => FILLERS.has(w));
}

/** One time the user talked over a reply, until it's dropped or resumed. */
export interface Interruption {
  at: number;
  /** Utterances from it still being transcribed. */
  pending: number;
  filler: boolean;
}

export class BargeIn {
  private playing: { text: string; startedAt: number; pausedMs: number; stop: () => void } | null = null;
  private current: Interruption | null = null;
  /** The user has been talking for a moment (BARGE_IN_MS), and hasn't finished. */
  private talking = false;
  /** Replies queued before this were talked over: they're dropped. */
  private dropBefore = 0;

  constructor(
    private readonly pause: (paused: boolean) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** A reply starts playing; `stop` cuts it. */
  play(text: string, stop: () => void): void {
    this.playing = { text, startedAt: this.now(), pausedMs: 0, stop };
  }

  played(): void {
    this.playing = null;
  }

  /** Was a reply queued at `queuedAt` talked over before it played? */
  dropped(queuedAt: number): boolean {
    return queuedAt < this.dropBefore;
  }

  /** The user has talked for BARGE_IN_MS (true), or stopped (false). */
  speech(talking: boolean): void {
    this.talking = talking;
    if (talking && this.playing && !this.current) {
      this.pause(true);
      this.current = { at: this.now(), pending: 0, filler: false };
      setTimeout(() => this.settle(), BARGE_IN_WAIT_MS).unref();
    }
    if (!talking) this.settle();
  }

  /** An utterance ended: the interruption it belongs to, if any, waits for its transcript. */
  utterance(): Interruption | null {
    if (this.current) this.current.pending++;
    return this.current;
  }

  /** Its transcript: what to hand Claude, or "" for a filler (the reply resumes) or a cough. */
  heard(from: Interruption | null, text: string): string {
    if (!from || from !== this.current) return text;
    if (isFiller(text)) {
      from.filler = true;
      return "";
    }
    const said = `(You interrupted Claude after: '${this.heardSoFar(from.at)}') ${text}`;
    this.drop();
    return said;
  }

  /** Its transcript is in, or failed. */
  done(from: Interruption | null): void {
    if (!from) return;
    from.pending--;
    this.settle();
  }

  /** Resume a talked-over reply once the user has stopped and said nothing real (a filler, or nothing within BARGE_IN_WAIT_MS). */
  settle(): void {
    const c = this.current;
    if (!c || this.talking || c.pending > 0 || !(c.filler || this.now() - c.at >= BARGE_IN_WAIT_MS)) return;
    this.pause(false);
    if (this.playing) this.playing.pausedMs += this.now() - c.at;
    this.current = null;
  }

  /** The call ended: nothing may stay paused (a stopped process can't act on SIGTERM). */
  end(): void {
    if (this.current) this.drop();
    else this.pause(false);
  }

  private drop(): void {
    this.dropBefore = this.now();
    this.playing?.stop();
    this.current = null;
    this.pause(false);
  }

  /** The words of the playing reply the user heard before talking over it. */
  private heardSoFar(at: number): string {
    if (!this.playing) return "…";
    // shortcut: estimated from the time played at an average pace, so off by a few words; upgrade when the voices report word timings.
    const { text, startedAt, pausedMs } = this.playing;
    const words = text.split(/\s+/).filter(Boolean);
    const n = Math.max(1, Math.round(((at - startedAt - pausedMs) / 1000) * WORDS_PER_SECOND));
    return n >= words.length ? text : `${words.slice(0, n).join(" ")}…`;
  }
}
