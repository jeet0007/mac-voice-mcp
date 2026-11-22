// The call session shell: audio, transcripts, files and timers around the pure call engine. See docs/specs/call-mode.md.
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
import { classify, echoes, heardSoFar } from "./engine/words.js";

const sttFailureFile = () => path.join(CONFIG.cacheDir, "last-stt-failure.json");

const missedNote = (count: number, error: string) =>
  `(voice-mcp note: speech to text failed on ${count === 1 ? "something" : `${count} things`} the user said just before this (${error}), ` +
  `so you may have missed words. Tell them, say what you did hear, and that the failure is recorded in ${sttFailureFile()}.)`;

const WATCH_MS = 250;
const EARLY_FAILURE_MS = 300;
// Fractions are fine: the tests use seconds.
const IDLE_MS = Math.max(0.01, envNum("VOICE_MCP_CALL_IDLE_MINUTES", 30)) * 60_000;
const DUCK_GAIN = 0.3;
const CHECK_START_MS = 300;
// setTimeout fires at once past this.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

type Happened = Event extends infer E ? (E extends unknown ? Omit<E, "at"> : never) : never;

interface Say {
  text: string;
  reply: Reply | null;
  failure: unknown;
  returned: boolean;
  settle: () => void;
}

export class Call {
  endedBecause = "";
  private engine: State = { phase: "off" };
  private events: Event[] = [];
  private draining = false;
  private wake: NodeJS.Timeout | undefined;
  private watch: NodeJS.Timeout | undefined;
  private session: AudioSession | null = null;
  private ctl: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private closing: Promise<void> = Promise.resolve();
  private requested = "";
  private ids = 0;
  private says = new Map<SayId, Say>();
  private transcripts = new Map<UtteranceId, string>();
  // Utterances are transcribed one at a time, in the order they were said.
  private transcribing: Promise<void> = Promise.resolve();
  // Finals queued or running; a word check would wait behind them in whisper.
  private finals = 0;
  private live: LiveTranscript | null = null;
  // A dropped say settles at once while the one before it may still play (a goodbye), so chain them all.
  private spoken: Promise<unknown> = Promise.resolve();
  private laterNotes: string[] = [];
  private sttError = "";
  private wakers = new Set<() => void>();

  get on(): boolean {
    return this.engine.phase === "on";
  }

  // The caller preflights and speaks the greeting.
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
    this.engine = initial({ interrupt: session.interrupt, thinkingTick: CONFIG.callThinkingSound, idleMs: IDLE_MS }, startedAt);
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

  async end(reason: string): Promise<void> {
    this.finish("requested", reason);
    await this.closing;
  }

  // Returns once speech has started or failed at once, with notes about earlier speech that failed.
  async say(text: string): Promise<string[]> {
    if (!this.on) return this.laterNotes.splice(0);
    const id = ++this.ids as SayId;
    let settle!: () => void;
    const done = new Promise<void>((resolve) => (settle = resolve));
    const say: Say = { text, reply: null, failure: null, returned: false, settle };
    this.says.set(id, say);
    this.spoken = Promise.all([this.spoken, done]);
    trackSpeaking(this.spoken);
    this.dispatch({ type: "say.requested", say: id });
    await Promise.race([done, sleep(EARLY_FAILURE_MS)]);
    say.returned = true;
    if (say.failure) throw say.failure;
    return this.laterNotes.splice(0);
  }

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

  // An event sent from inside an effect waits its turn, so the engine finishes one before the next.
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

  // A tick that comes early changes nothing and arms the timer again.
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
      case "speech.duck":
        return this.says.get(effect.say)?.reply?.duck(DUCK_GAIN);
      case "speech.restore":
        return this.says.get(effect.say)?.reply?.duck(1);
      case "speech.pause":
        return this.says.get(effect.say)?.reply?.pause();
      case "speech.resume":
        return this.says.get(effect.say)?.reply?.resume();
      case "words.check":
        return this.checkWords(effect.say);
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

  private checkWords(id: SayId): void {
    const live = this.live;
    const reply = this.says.get(id)?.text ?? "";
    void (live ? live.check(CHECK_START_MS) : Promise.resolve(null)).then((partial) => {
      const words = partial === null ? null : ["words", "hang-up"].includes(classify(partial)) && !echoes(partial, reply);
      this.dispatch({ type: "words.checked", words, quietMs: live?.quietMs ?? 0 });
    });
  }

  // Synchronous, so a shutdown that exits right after leaves nothing behind.
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
    const live = (this.live = new LiveTranscript({
      everyMs: CONFIG.liveTranscriptMs,
      enabled: () => bubbleTakesText() && partialsAvailable(),
      ready: () => partialsAvailable() && !this.finals,
      request: (wav, sig) => transcribePartial(wav, sig),
      emit: (text) => void sendToBubble({ type: "partial", text }),
    }));
    try {
      await listenContinuously(session, {
        onHeard: (heard) => {
          if (heard.kind === "onset") return this.dispatch({ type: "speech.onset" });
          if (heard.kind !== "ended") return this.dispatch({ type: "speech.dropped", reason: heard.kind });
          const utterance = ++this.ids as UtteranceId;
          this.dispatch({ type: "utterance.ended", utterance, reason: heard.reason });
          this.finals++;
          this.transcribing = this.transcribing
            .then(() => this.transcribe(utterance, heard.wav, model, signal))
            .finally(() => this.finals--)
            .catch((e: unknown) => log(`call: transcription chain failed: ${e instanceof Error ? e.message : String(e)}`)); // one failure mustn't stop the rest of the call being heard
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
      if (signal.aborted) return;
      this.transcripts.set(utterance, transcript);
      this.dispatch({ type: "transcribed", utterance, heard: classify(transcript) });
    } catch (err) {
      if (!signal.aborted && !(err instanceof CancelledError)) this.notHeard(utterance, err, model);
    } finally {
      this.transcripts.delete(utterance);
    }
  }

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
      // no inbox yet
    }
    if (this.engine.undelivered && !waiting) this.dispatch({ type: "inbox.drained" });
  }
}

export const call = new Call();
