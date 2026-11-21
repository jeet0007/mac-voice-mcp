/**
 * A call: the mic stays open from `call start` until the user hangs up, like a phone call, instead
 * of one turn at a time (docs/specs/call-mode.md).
 *
 * This is the shell around the call engine (engine/step.ts), which holds every rule: when a reply
 * plays, waits, pauses or stops, when Claude is thinking, when the call ends. The shell owns what
 * the engine can't touch: the audio session, the transcripts and the texts of the replies (the
 * engine knows them by id), the voice-mode files and the timers. It turns what happens into events,
 * and does what the engine decides.
 *
 * One audio session runs for the whole call (src/listen/utterances.ts listenContinuously). Each
 * utterance is transcribed on this Mac and left in the inbox for `listen`, `say`, the plugin hook or
 * Voice Buddy to hand to Claude. The session holds the mic lock throughout, so other windows' voice
 * turns give up at once. On speakers the mic can't hear the user while `say` plays
 * (src/audio/device.ts), so a reply waits for them to finish their sentence; on headphones it stays
 * open, so the user can talk over Claude: speech pauses the reply, real words drop the rest of it,
 * and a filler ("mm-hm") or a cough resumes it.
 *
 * It ends when the user says "hang up", when Claude calls `call end`, after
 * VOICE_MCP_CALL_IDLE_MINUTES (default 30) without a word either way, when call.json disappears
 * (the plugin hook removes it when the session ends), when the recorder fails, or at shutdown.
 * After the user's words reach Claude a soft tick plays every 1.5 s until Claude speaks (10 s at most),
 * and a permission prompt on screen is said out loud, so the line never goes quiet while Claude waits.
 * Ending stops the recorder within a second and empties the inbox. Nothing is spoken: Claude notes it on screen.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openAudio, type AudioSession } from "../audio/device.js";
import { bubbleTakesText, bubbleWanted, sendToBubble, startBubble, stopBubble } from "../bubble.js";
import { CONFIG, debug, envNum, log, PKG } from "../config.js";
import { thinkingTick } from "../cues.js";
import { recordStep } from "../flight.js";
import { prewarmKokoro } from "../kokoro.js";
import { listenContinuously } from "../listen/utterances.js";
import { LiveTranscript } from "../live-transcript.js";
import { ensureModel } from "../model.js";
import { CancelledError, sleep } from "../proc.js";
import { speak, type Reply } from "../speech/replies.js";
import { addToInbox, callFile, inboxDir, levelsFile, muteFile, permissionFile, readJson, setOwnSession, showPhase, takeInbox, voiceModeDir, type InboxEntry } from "../state/voice-mode.js";
import { partialsAvailable, prewarm, transcribeBuffer, transcribePartial } from "../stt.js";
import { PERMISSION_NOTICE } from "../texts.js";
import { trackSpeaking } from "../voice.js";
import { initial, nextWake, step } from "./engine/step.js";
import type { Effect, EndReason, Event, SayId, State, UtteranceId } from "./engine/types.js";
import { classify, heardSoFar } from "./engine/words.js";

/** The last speech-to-text failure on a call, kept for debugging (and a future /issue). */
const sttFailureFile = () => path.join(CONFIG.cacheDir, "last-stt-failure.json");

const missedNote = (count: number, error: string) =>
  `(voice-mcp note: speech to text failed on ${count === 1 ? "something" : `${count} things`} the user said just before this (${error}), ` +
  `so you may have missed words. Tell them, say what you did hear, and that the failure is recorded in ${sttFailureFile()}.)`;

/** How often the call checks call.json, the permission notice and the inbox. */
const WATCH_MS = 250;
/** A `say` that fails right away (no voice installed) is reported by that call; later failures by the next one. */
const EARLY_FAILURE_MS = 300;
/** The call ends after this long without a word either way. Fractions are fine (the tests use seconds). */
const IDLE_MS = Math.max(0.01, envNum("VOICE_MCP_CALL_IDLE_MINUTES", 30)) * 60_000;
/** The longest setTimeout takes: a longer one fires at once. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** An engine event, before the shell stamps it with the time. */
type Happened = Event extends infer E ? (E extends unknown ? Omit<E, "at"> : never) : never;

/** One `say`: what the engine knows by id. */
interface Say {
  text: string;
  reply: Reply | null;
  /** Why it couldn't be spoken, if that was known before `say` returned. */
  failure: unknown;
  returned: boolean;
  /** It has played, failed, or was dropped. */
  settle: () => void;
}

export class Call {
  /** Why the last call ended, for a `listen` or `say` that comes after. */
  endedBecause = "";
  private engine: State = { phase: "off" };
  private events: Event[] = [];
  private draining = false;
  /** The engine's next deadline. */
  private wake: NodeJS.Timeout | undefined;
  private watch: NodeJS.Timeout | undefined;
  private session: AudioSession | null = null;
  private ctl: AbortController | null = null;
  private loop: Promise<void> | null = null;
  /** The last call giving the mic back. */
  private closing: Promise<void> = Promise.resolve();
  /** Why `end.requested` was sent. */
  private requested = "";
  /** Says and utterances take their ids from one counter. */
  private ids = 0;
  private says = new Map<SayId, Say>();
  /** Each transcript, while the engine decides what to do with it. */
  private transcripts = new Map<UtteranceId, string>();
  /** Utterances are transcribed in the order they were said. */
  private transcribing: Promise<void> = Promise.resolve();
  /** Problems with earlier speech, reported in the next result. */
  private laterNotes: string[] = [];
  private sttError = "";
  private wakers = new Set<() => void>();

  get on(): boolean {
    return this.engine.phase === "on";
  }

  /** Take the mic for the call. Resolves "already" when one is on. The caller preflights and speaks the greeting. */
  async start(signal?: AbortSignal): Promise<"started" | "already"> {
    if (this.on) return "already";
    await this.closing;
    const session = await openAudio({ purpose: "call", signal });
    const ctl = new AbortController();
    this.session = session;
    this.ctl = ctl;
    this.endedBecause = "";
    rmSync(muteFile(), { force: true });
    rmSync(permissionFile(), { force: true });
    const startedAt = Date.now();
    const duplex = session.interrupt === "none" ? "half" : "full";
    this.engine = initial({ interrupt: duplex === "half" ? "none" : "pause", thinkingTick: CONFIG.callThinkingSound, idleMs: IDLE_MS }, startedAt);
    mkdirSync(voiceModeDir(), { recursive: true });
    writeFileSync(callFile(), JSON.stringify({ pid: process.pid, startedAt, duplex }));
    this.watch = setInterval(() => this.poll(), WATCH_MS);
    this.arm();
    startBubble();
    this.loop = this.run(session, ctl.signal).catch((e: unknown) => {
      if (this.ctl !== ctl || e instanceof CancelledError) return;
      this.finish("mic-lost", `voice-mcp lost the microphone: ${e instanceof Error ? e.message : String(e)}`);
    });
    return "started";
  }

  /** End the call for `reason`, whatever state it's in; harmless when it's already over. */
  async end(reason: string): Promise<void> {
    this.finish("requested", reason);
    await this.closing;
  }

  /**
   * Queue `text` for the speaker and return once it has started (or failed at once). While it
   * plays on speakers the mic can't hear the user, so there it first waits for them to finish their sentence; typing doesn't stop it. Returns notes about earlier speech that failed.
   */
  async say(text: string): Promise<string[]> {
    if (!this.on) return this.laterNotes.splice(0);
    const id = ++this.ids as SayId;
    let settle!: () => void;
    const done = new Promise<void>((resolve) => (settle = resolve));
    const say: Say = { text, reply: null, failure: null, returned: false, settle };
    this.says.set(id, say);
    trackSpeaking(done);
    this.dispatch({ type: "say.requested", say: id });
    await Promise.race([done, sleep(EARLY_FAILURE_MS)]);
    say.returned = true;
    if (say.failure) throw say.failure;
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

  /**
   * Hand the engine what happened, and do what it decides. An event sent from inside an effect
   * waits its turn, so the engine never sees one before it has finished with the one before.
   */
  private dispatch(event: Happened): void {
    this.events.push({ ...event, at: Date.now() } as Event);
    if (this.draining) return;
    this.draining = true;
    try {
      for (let e = this.events.shift(); e; e = this.events.shift()) {
        const [next, effects] = step(this.engine, e);
        this.engine = next;
        recordStep(e, effects);
        for (const effect of effects) this.perform(effect);
      }
    } finally {
      this.draining = false;
      this.arm();
    }
  }

  /** One timer for every deadline of the engine. A tick that comes early changes nothing and arms the timer again. */
  private arm(): void {
    clearTimeout(this.wake);
    const at = nextWake(this.engine);
    if (at === null) return;
    this.wake = setTimeout(() => this.dispatch({ type: "tick" }), Math.min(Math.max(0, at - Date.now()), MAX_TIMEOUT_MS));
  }

  private perform(effect: Effect): void {
    switch (effect.type) {
      case "speech.start":
        return this.play(effect.say);
      case "speech.pause":
        return this.says.get(effect.say)?.reply?.duck(0);
      case "speech.resume":
        return this.says.get(effect.say)?.reply?.duck(1);
      case "speech.stop":
        return this.says.get(effect.say)?.reply?.stop();
      case "speech.drop":
        this.says.get(effect.say)?.settle();
        this.says.delete(effect.say);
        return;
      case "deliver": {
        const transcript = this.transcripts.get(effect.utterance)!;
        const cut = effect.interrupted;
        const interrupted = cut ? `(You interrupted Claude after: '${heardSoFar(this.says.get(cut.say)!.text, cut.playedMs)}') ` : "";
        const missed = effect.missed ? `${missedNote(effect.missed, this.sttError)} ` : "";
        sendToBubble({ type: "final", text: transcript }); // display only: the notes are for Claude
        addToInbox(missed + interrupted + transcript);
        for (const wake of this.wakers) wake();
        return;
      }
      case "cue":
        return void thinkingTick();
      case "teardown":
        return this.teardown(effect.reason);
    }
  }

  private play(id: SayId): void {
    const say = this.says.get(id)!;
    showPhase("speaking");
    const reply = (say.reply = speak(say.text));
    void (async () => {
      try {
        await reply.done;
      } catch (err) {
        if (!(err instanceof CancelledError)) {
          if (!say.returned) say.failure = err;
          else this.laterNotes.push(`voice-mcp note: what you last said wasn't heard: ${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        this.says.delete(id);
        if (this.on) showPhase(null);
        this.dispatch({ type: "playback.ended", say: id });
        say.settle();
      }
    })();
  }

  /** Everything that must not outlive the call, done at once: a shutdown that exits right after leaves nothing behind. */
  private teardown(reason: EndReason): void {
    this.endedBecause = reason === "hang-up" ? "the user hung up" : reason === "idle" ? `nobody said anything for ${Math.round(IDLE_MS / 60_000)} minutes` : this.requested;
    log(`call ended: ${this.endedBecause}`);
    const { ctl, loop, session } = this;
    this.ctl = null;
    this.loop = null;
    this.session = null;
    clearInterval(this.watch);
    ctl!.abort();
    takeInbox();
    rmSync(callFile(), { force: true });
    rmSync(muteFile(), { force: true });
    rmSync(levelsFile(), { force: true });
    stopBubble();
    showPhase(null);
    const closed = session!.close(); // stops the recorder now; gives the mic back once it has exited
    for (const wake of this.wakers) wake();
    this.closing = Promise.all([loop, closed]).then(() => {});
  }

  /** Ask the engine to end the call; `because` is what a later `listen` or `say` is told. */
  private finish(reason: (Event & { type: "end.requested" })["reason"], because: string): void {
    if (!this.on) return;
    this.requested = because;
    this.dispatch({ type: "end.requested", reason });
  }

  private async run(session: AudioSession, signal: AbortSignal): Promise<void> {
    const model = await ensureModel({ download: false });
    prewarm(model);
    prewarmKokoro(); // the first words of the call shouldn't wait for the voice to load
    let levelFrames = 0;
    // Rough words while the user talks, for the bubble's panel only (docs/specs/live-transcript.md).
    const live = new LiveTranscript({
      everyMs: CONFIG.liveTranscriptMs,
      enabled: () => bubbleTakesText() && partialsAvailable(),
      request: (wav, sig) => transcribePartial(wav, sig),
      emit: (text) => void sendToBubble({ type: "partial", text }),
    });
    try {
      await listenContinuously(session, {
        onHeard: (heard) => {
          if (heard.kind === "onset") return this.dispatch({ type: "speech.onset" });
          if (heard.kind !== "ended") return this.dispatch({ type: "speech.dropped", reason: heard.kind });
          const utterance = ++this.ids as UtteranceId;
          this.dispatch({ type: "utterance.ended", utterance, reason: heard.reason });
          this.transcribing = this.transcribing.then(() => this.transcribe(utterance, heard.wav, model, signal));
        },
        // Every other 30 ms frame is plenty for the bubble's glow, which smooths it anyway.
        onLevel: (db, thresholdDb) => {
          if (bubbleWanted() && ++levelFrames % 2 === 0 && Number.isFinite(thresholdDb)) {
            writeFileSync(levelsFile(), `${db.toFixed(1)} ${thresholdDb.toFixed(1)}`);
          }
        },
        live,
      });
    } finally {
      await this.transcribing;
    }
  }

  private async transcribe(utterance: UtteranceId, wav: Buffer, model: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    try {
      const transcript = await transcribeBuffer(wav, model, signal);
      debug(`call heard: ${JSON.stringify(transcript)}`);
      if (signal.aborted) return; // the call ended meanwhile
      this.transcripts.set(utterance, transcript);
      this.dispatch({ type: "transcribed", utterance, heard: classify(transcript) });
    } catch (err) {
      if (!signal.aborted && !(err instanceof CancelledError)) this.notHeard(utterance, err, model);
    } finally {
      this.transcripts.delete(utterance);
    }
  }

  /** Speech to text failed on something the user said: record it, and tell Claude with the next thing heard. */
  private notHeard(utterance: UtteranceId, err: unknown, model: string): void {
    const error = err instanceof Error ? err.message : String(err);
    log(`call: speech to text failed: ${error}`);
    this.sttError = error;
    this.dispatch({ type: "transcribe.failed", utterance });
    const failures = this.engine.phase === "on" ? this.engine.missed : 0;
    try {
      writeFileSync(
        sttFailureFile(),
        JSON.stringify({ at: new Date().toISOString(), error, failures, model, version: PKG.version, platform: `${process.platform} ${os.release()}` }, null, 2),
      );
    } catch (e) {
      log(`call: couldn't record the failure: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** The world outside the engine: call.json, the permission notice, the inbox. */
  private poll(): void {
    if (this.engine.phase !== "on") return;
    const mark = readJson(callFile()) as { pid?: unknown; session?: unknown } | null;
    if (mark?.pid !== process.pid) return this.finish("session-ended", "the session ended");
    setOwnSession(mark.session); // the hook added it: this window's session, so another window's typing can't stop us
    if (existsSync(permissionFile())) {
      rmSync(permissionFile(), { force: true });
      void this.say(PERMISSION_NOTICE).then(
        (notes) => this.laterNotes.unshift(...notes),
        (e: unknown) => log(`call: couldn't say the permission notice: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
    // Voice Buddy blanks an inbox entry once it has handed it to Claude: nothing is kept.
    let waiting = false;
    try {
      for (const name of readdirSync(inboxDir())) {
        const file = path.join(inboxDir(), name);
        if (statSync(file).size === 0) rmSync(file, { force: true });
        else if (name.endsWith(".json")) waiting = true;
      }
    } catch {
      /* no inbox yet */
    }
    if (this.engine.undelivered && !waiting) this.dispatch({ type: "inbox.drained" });
  }
}

export const call = new Call();
