/**
 * A call: the mic stays open from `call start` until the user hangs up, like a phone call, instead
 * of one turn at a time (docs/specs/call-mode.md).
 *
 * One recorder runs for the whole call (src/audio.ts listenContinuously). Each utterance is
 * transcribed on this Mac, checked for a hang-up phrase, and left in the inbox for `listen`, `say`,
 * the plugin hook or Voice Buddy to hand to Claude. The call holds the mic lock throughout, so
 * other windows' voice turns give up at once. On speakers the mic is gated while `say` plays (half
 * duplex); on headphones it stays open, so the user can talk over Claude (full duplex): speech
 * pauses the reply, real words drop the rest of it, and a filler ("mm-hm") or a cough resumes it.
 *
 * It ends when the user says "hang up", when Claude calls `call end`, after
 * VOICE_MCP_CALL_IDLE_MINUTES (default 30) without a word either way, when call.json disappears
 * (the plugin hook removes it when the session ends), when the recorder fails, or at shutdown.
 * Ending stops the recorder within a second and empties the inbox. Nothing is spoken: Claude notes it on screen.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as files from "../hooks/voice-files.mjs";
import { listenContinuously, speak } from "./audio.js";
import { BargeIn, type Interruption } from "./barge-in.js";
import { CONFIG, debug, envNum, log, PKG } from "./config.js";
import { acquireMicLock } from "./lock.js";
import { ensureModel } from "./model.js";
import { CancelledError, sleep } from "./proc.js";
import { detectDuplex, pauseSpeech } from "./speakers.js";
import { prewarm, transcribe } from "./stt.js";
import { addToInbox, inboxDir, showPhase, takeInbox, voiceModeDir, type InboxEntry } from "./worklisten.js";
import { trackSpeaking } from "./voice.js";

/** Shared with the plugin hook and Voice Buddy: who is on a call, and which session it belongs to. */
export const callFile = () => files.callFile(voiceModeDir());

export const muteFile = () => files.muteFile(voiceModeDir());

/** The last speech-to-text failure on a call, kept for debugging (and a future /issue). */
export const sttFailureFile = () => path.join(CONFIG.cacheDir, "last-stt-failure.json");

const missedNote = ({ count, error }: { count: number; error: string }) =>
  `(voice-mcp note: speech to text failed on ${count === 1 ? "something" : `${count} things`} the user said just before this (${error}), ` +
  `so you may have missed words. Tell them, say what you did hear, and that the failure is recorded in ${sttFailureFile()}.)`;

/** How often the call checks for idleness, call.json and leftovers in the inbox. */
const WATCH_MS = 250;
/** The speaker's echo reaches the mic a moment after speech ends. */
const ECHO_TAIL_MS = 300;
/** A `say` that fails right away (no voice installed) is reported by that call; later failures by the next one. */
const EARLY_FAILURE_MS = 300;
/** The call ends after this long without a word either way. Fractions are fine (the tests use seconds). */
const IDLE_MS = Math.max(0.01, envNum("VOICE_MCP_CALL_IDLE_MINUTES", 30)) * 60_000;

/**
 * Does the whole transcript mean "hang up"? Politeness and the name around it are fine
 * ("Okay, hang up now.", "Bye, Claude."); a negation is not ("Don't hang up yet.").
 */
export function isHangUp(text: string): boolean {
  const t = text.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();
  if (/\b(?:don't|do not|not|never)\b/.test(t)) return false;
  const around = "(?:okay|ok|alright|all right|yes|yeah|so|um|uh|well|please|thanks|thank you|now|for now|let's|can you|could you|claude|and)";
  const core = "(?:hang up|hangup|end (?:the )?call|(?:good)?bye claude)";
  return new RegExp(`^(?:${around} )*${core}(?: ${around})*$`).test(t);
}

export type CallState = "off" | "on" | "ending";

export class Call {
  state: CallState = "off";
  /** Why the last call ended, for a `listen` or `say` that comes after. */
  endedBecause = "";
  private release: (() => void) | null = null;
  private ctl: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private watch: NodeJS.Timeout | null = null;
  private lastActivity = 0;
  /** Resolved at call start (VOICE_MCP_CALL_DUPLEX, or headphones detected). */
  private duplex: "full" | "half" = "half";
  /** Mic frames are dropped until then (our own speech, plus its echo). */
  private muteUntil = 0;
  /** The user muted the call (muteFile), refreshed every tick. */
  private userMuted = false;
  /** `say` calls play one after another. */
  private speaking: Promise<void> = Promise.resolve();
  /** The user talking over `say` (full duplex). A fresh one each call. */
  private bargeIn = new BargeIn(pauseSpeech);
  /** Utterances are transcribed in the order they were said. */
  private transcribing: Promise<void> = Promise.resolve();
  /** Problems with earlier speech, reported in the next result. */
  private laterNotes: string[] = [];
  /** Things the user said that speech to text failed on, since the last one it heard. */
  private missed: { count: number; error: string } | null = null;
  private wakers = new Set<() => void>();

  get on(): boolean {
    return this.state === "on";
  }

  /** Take the mic for the call. Resolves "already" when one is on. The caller preflights and speaks the greeting. */
  async start(signal?: AbortSignal): Promise<"started" | "already"> {
    if (this.state === "on") return "already";
    while (this.state === "ending") await sleep(50);
    const duplex = await detectDuplex(); // before taking the mic, so a call end meanwhile still cancels the wait
    const release = await acquireMicLock({ signal, call: true });
    const ctl = new AbortController();
    this.release = release;
    this.ctl = ctl;
    this.state = "on";
    this.endedBecause = "";
    this.missed = null;
    this.muteUntil = 0;
    this.userMuted = false;
    rmSync(muteFile(), { force: true });
    this.bargeIn = new BargeIn(pauseSpeech);
    this.duplex = duplex;
    this.lastActivity = Date.now();
    mkdirSync(voiceModeDir(), { recursive: true });
    writeFileSync(callFile(), JSON.stringify({ pid: process.pid, startedAt: this.lastActivity, duplex: this.duplex }));
    this.watch = setInterval(() => this.tick(), WATCH_MS);
    this.loop = this.run(ctl.signal).catch((e: unknown) => {
      if (this.ctl !== ctl || e instanceof CancelledError) return;
      void this.end(`voice-mcp lost the microphone: ${e instanceof Error ? e.message : String(e)}`);
    });
    return "started";
  }

  /** End the call for `reason`, whatever state it's in; harmless when it's already over. */
  async end(reason: string): Promise<void> {
    if (this.state !== "on") return;
    this.state = "ending";
    this.endedBecause = reason;
    log(`call ended: ${reason}`);
    const { ctl, loop, release } = this;
    this.ctl = null;
    this.loop = null;
    this.release = null;
    clearInterval(this.watch!);
    this.watch = null;
    // Everything that must not outlive the call happens before the first await, so a shutdown
    // that exits right after calling this still leaves nothing behind.
    ctl!.abort();
    this.bargeIn.end();
    takeInbox();
    rmSync(callFile(), { force: true });
    rmSync(muteFile(), { force: true });
    showPhase(null);
    release!();
    for (const wake of this.wakers) wake();
    try {
      await loop;
    } finally {
      this.state = "off";
    }
  }

  /**
   * Queue `text` for the speaker and return once it has started (or failed at once). While it
   * plays the mic is gated on speakers (half duplex); typing doesn't stop it. Returns notes about earlier speech that failed.
   */
  async say(text: string): Promise<string[]> {
    let failure: unknown = null;
    let returned = false;
    const startedAt = Date.now();
    const play = async () => {
      if (!this.on || this.bargeIn.dropped(startedAt)) return;
      this.muteUntil = Infinity;
      showPhase("speaking");
      const ctl = new AbortController();
      this.bargeIn.play(text, () => ctl.abort());
      try {
        await speak(text, ctl.signal);
      } catch (err) {
        if (!(err instanceof CancelledError)) {
          if (!returned) failure = err;
          else this.laterNotes.push(`voice-mcp note: what you last said wasn't heard: ${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        this.bargeIn.played();
        this.muteUntil = Date.now() + ECHO_TAIL_MS;
        this.lastActivity = Date.now();
        if (this.on) showPhase(null);
      }
    };
    const done = this.speaking.then(play);
    this.speaking = done;
    trackSpeaking(done);
    await Promise.race([done, sleep(EARLY_FAILURE_MS)]);
    returned = true;
    if (failure) throw failure;
    return this.laterNotes.splice(0);
  }

  /** What the user has said so far, oldest first; waits up to `ms` for the first word. */
  async listen(ms: number, signal?: AbortSignal): Promise<InboxEntry[]> {
    const deadline = Date.now() + ms;
    for (;;) {
      const said = takeInbox();
      if (said.length || !this.on) return said;
      const left = deadline - Date.now();
      if (left <= 0 || signal?.aborted) return [];
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", wake);
          this.wakers.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, left);
        signal?.addEventListener("abort", wake, { once: true });
        this.wakers.add(wake);
      });
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    const model = await ensureModel({ download: false });
    prewarm(model);
    const dir = await mkdtemp(path.join(os.tmpdir(), "voice-mcp-call-"));
    try {
      await listenContinuously(signal, {
        dir,
        muted: () => this.userMuted || (this.duplex === "half" && Date.now() < this.muteUntil),
        onUtterance: (wav) => {
          const from = this.bargeIn.utterance();
          this.transcribing = this.transcribing
            .then(() => this.heard(wav, model, signal, from))
            .catch((e: unknown) => this.notHeard(e, model, signal))
            .finally(() => this.bargeIn.done(from));
        },
        onSpeech: (talking) => {
          if (this.duplex === "full") this.bargeIn.speech(talking);
        },
      });
    } finally {
      await this.transcribing;
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** `from`: the reply this utterance talked over, if any. */
  private async heard(wav: string, model: string, signal: AbortSignal, from: Interruption | null): Promise<void> {
    if (signal.aborted) return;
    const transcript = await transcribe(wav, model, signal).finally(() => rmSync(wav, { force: true }));
    debug(`call heard: ${JSON.stringify(transcript)}`);
    if (signal.aborted) return; // the call ended meanwhile
    if (isHangUp(transcript)) {
      void this.end("the user hung up");
      return;
    }
    const text = this.bargeIn.heard(from, transcript);
    if (!text) return; // a cough, or a filler said over Claude (its reply resumes)
    this.lastActivity = Date.now();
    addToInbox(this.missed ? `${missedNote(this.missed)} ${text}` : text);
    this.missed = null;
    for (const wake of this.wakers) wake();
  }

  /** Speech to text failed on something the user said: record it, and tell Claude with the next thing heard. */
  private notHeard(err: unknown, model: string, signal: AbortSignal): void {
    if (signal.aborted || err instanceof CancelledError) return;
    const error = err instanceof Error ? err.message : String(err);
    log(`call: speech to text failed: ${error}`);
    this.missed = { count: (this.missed?.count ?? 0) + 1, error };
    try {
      writeFileSync(
        sttFailureFile(),
        JSON.stringify({ at: new Date().toISOString(), error, failures: this.missed.count, model, version: PKG.version, platform: `${process.platform} ${os.release()}` }, null, 2),
      );
    } catch (e) {
      log(`call: couldn't record the failure: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private tick(): void {
    if (!this.on) return;
    this.bargeIn.settle(); // backs up its timer, which may fire a moment early
    this.userMuted = existsSync(muteFile());
    if (Date.now() - this.lastActivity > IDLE_MS) {
      void this.end(`nobody said anything for ${Math.round(IDLE_MS / 60_000)} minutes`);
      return;
    }
    if ((files.readJson(callFile()) as { pid?: unknown } | null)?.pid !== process.pid) {
      void this.end("the session ended");
      return;
    }
    // Voice Buddy blanks an inbox entry once it has handed it to Claude: nothing is kept.
    try {
      for (const name of readdirSync(inboxDir())) {
        const file = path.join(inboxDir(), name);
        if (statSync(file).size === 0) rmSync(file, { force: true });
      }
    } catch {
      /* no inbox yet */
    }
  }
}

export const call = new Call();
