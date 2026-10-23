/** The round trip: speak → listen for one turn → transcribe. */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chime, findRecorder, listenForTurn, MIC_PERMISSION_HINT, RECORDER_MISSING, speak, type Spoken } from "./audio.js";
import { CONFIG, debug, DEFAULT_LISTEN_SECONDS, log, MAX_LISTEN_SECONDS, MAX_SPEAK_CHARS } from "./config.js";
import { acquireMicLock, MicBusyError } from "./lock.js";
import { ensureModel } from "./model.js";
import { CancelledError, resetWhichCache, SetupError, sleep } from "./proc.js";
import { prepareSpeech } from "./speech-text.js";
import { findWhisperCli, findWhisperServer, prewarm, STT_MISSING, transcribe } from "./stt.js";
import { interjectionNote, showPhase, stopRequestedSince, takeInbox, workListener } from "./worklisten.js";

export interface VoiceResult {
  ok: boolean;
  text: string;
  notes: string[];
  /** The user answered out loud (a real transcript, not "no speech" or an error). */
  heard?: boolean;
}

/** Everything speak_and_listen needs, checked before saying a word. Never installs anything. */
async function preflight(): Promise<{ model: string }> {
  if (!findRecorder()) throw new SetupError(RECORDER_MISSING);
  if (!findWhisperCli() && !findWhisperServer()) throw new SetupError(STT_MISSING);
  return { model: await ensureModel({ download: false }) };
}

export type Phase = "waiting" | "speaking" | "listening" | "transcribing";

export interface SpeakOptions {
  /** Upper limit on listening, in seconds. */
  listenSeconds?: number;
  /** false: only speak — don't open the mic (announcements, or saying goodbye when leaving voice mode). */
  listen?: boolean;
  signal?: AbortSignal;
  onPhase?: (phase: Phase) => void;
}

/**
 * A spoken update (listen: false) still playing in the background, and notes from it for the next
 * result (a Kokoro fallback, or an error after the call had already returned).
 */
let speaking: Promise<void> | null = null;
const laterNotes: string[] = [];

/** How long a spoken update waits for an early failure (no voice installed…) before returning. */
const EARLY_FAILURE_MS = 300;

/** What Claude is told when the user starts typing during a voice turn (the voice-buddy mod's signal). */
export const USER_TYPED =
  "(The user started typing instead of answering by voice, so voice-mcp stopped speaking and listening. " +
  "Stop here and wait for their typed message; don't call speak_and_listen again unless they ask to talk.)";
/** How often a voice turn checks whether the user started typing. */
const STOP_POLL_MS = 100;

/** Abort when the user starts typing (a stop signal at or after `since`), or when `signal` aborts. */
function watchForTyping(since: number, signal?: AbortSignal) {
  const ctl = new AbortController();
  let typed = false;
  const onAbort = () => ctl.abort();
  if (signal?.aborted) ctl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const check = () => {
    if (!typed && stopRequestedSince(since)) {
      typed = true;
      ctl.abort();
    }
  };
  check();
  const timer = setInterval(check, STOP_POLL_MS);
  return {
    signal: ctl.signal,
    get typed() {
      return typed;
    },
    dispose() {
      clearInterval(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** Wait for a spoken update to finish (another turn needs the speaker). */
export async function finishSpeaking(): Promise<void> {
  await speaking;
}

export async function speakAndListen(textToSpeak: string, opts: SpeakOptions = {}): Promise<VoiceResult> {
  // One speaker: a spoken update from the last call finishes first.
  await finishSpeaking();
  const { signal } = opts;
  const startedAt = Date.now();
  const onPhase = (phase: Phase) => {
    showPhase(phase);
    opts.onPhase?.(phase);
  };
  // The mic is ours for this turn: stop listening in the background, and pass on anything the
  // user said while Claude worked that the plugin's hook hasn't delivered yet.
  const wasListening = workListener.running;
  await workListener.stop();
  const waiting = interjectionNote(takeInbox());
  const listen = opts.listen !== false;
  const requested = opts.listenSeconds ?? DEFAULT_LISTEN_SECONDS;
  const seconds = Math.min(MAX_LISTEN_SECONDS, Math.max(1, Number.isFinite(requested) ? requested : DEFAULT_LISTEN_SECONDS));
  const model = listen ? (await preflight()).model : null;
  // Load the model into the warm server now, so it's ready when the user finishes (even if we wait below).
  if (model) prewarm(model);

  // Wait for any other voice session on this Mac to finish with the speaker and mic.
  let release: () => void;
  try {
    release = await acquireMicLock({ signal, onWait: () => onPhase("waiting") });
  } catch (err) {
    showPhase(null); // gave up waiting for the mic, or cancelled: don't leave "waiting" showing
    if (err instanceof MicBusyError) return { ok: false, text: err.message, notes: waiting ? [waiting] : [] };
    throw err;
  }
  if (!listen) return speakInBackground(textToSpeak, { release, onPhase, waiting, keepListening: wasListening, startedAt });
  let result: VoiceResult;
  // The user starts typing: stop talking and listening now, not after the 15-second wait for speech.
  const typing = watchForTyping(startedAt, signal);
  try {
    result = await turn(textToSpeak, seconds, model!, typing.signal, onPhase);
  } catch (err) {
    if (!(typing.typed && err instanceof CancelledError)) throw err;
    result = { ok: true, text: USER_TYPED, notes: [] };
  } finally {
    typing.dispose();
    showPhase(null);
    release();
  }
  result.notes.unshift(...laterNotes.splice(0));
  if (waiting) result.notes.unshift(waiting);
  // They answered out loud: keep listening while Claude works, for "Claude, …".
  if (result.heard) workListener.start();
  return result;
}

/**
 * A spoken update ("give me a few minutes"): return right away, so Claude carries on working while
 * it plays (each one used to hold Claude up for the whole sentence, 7-12 s), and keep the speaker
 * and mic until it's done. An error in the first moment (no voice installed) is still reported here;
 * anything later goes with the next result.
 */
async function speakInBackground(
  textToSpeak: string,
  o: { release: () => void; onPhase: (phase: Phase) => void; waiting: string | null; keepListening: boolean; startedAt: number },
): Promise<VoiceResult> {
  const speech = prepareSpeech(textToSpeak, { maxWords: CONFIG.maxSpeakWords, maxChars: MAX_SPEAK_CHARS });
  const t0 = Date.now();
  let returned = false;
  let failure: unknown = null;
  o.onPhase("speaking");
  // Not tied to this request's signal (the request is over long before the sentence is), but the
  // user starting to type stops it.
  const typing = watchForTyping(o.startedAt);
  const done = speak(speech.text, typing.signal)
    .then(
      (spoken) => {
        const fallback = fallbackNote(spoken);
        if (fallback) laterNotes.push(fallback);
        debug(`spoken update finished after ${secs(Date.now() - t0)}`);
      },
      (err: unknown) => {
        if (err instanceof CancelledError) return;
        if (!returned) {
          failure = err; // reported by this call, below
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        log("spoken update failed:", message);
        laterNotes.push(`voice-mcp note: your last spoken update wasn't heard: ${message}`);
      },
    )
    .finally(() => {
      typing.dispose();
      showPhase(null);
      o.release();
      // Listening while Claude works resumes once the speaker is quiet, so it doesn't hear itself.
      // It counts from when this call returned, which is when the plugin's hook marked the session.
      if (o.keepListening && !failure && !typing.typed) workListener.start(t0);
    });
  const tracked: Promise<void> = done.finally(() => {
    if (speaking === tracked) speaking = null;
  });
  speaking = tracked;

  // Fails right away (no voice installed, bad setup)? Then say so now, as before.
  await Promise.race([done, sleep(EARLY_FAILURE_MS)]);
  returned = true;
  if (failure) throw failure;
  const notes = [...speech.notes, ...laterNotes.splice(0)];
  if (o.waiting) notes.unshift(o.waiting);
  return {
    ok: true,
    text: "(Speaking in the background, so you can carry on working. The microphone was not opened, because listen was false.)",
    notes,
  };
}

async function turn(
  textToSpeak: string,
  seconds: number,
  model: string,
  signal: AbortSignal | undefined,
  onPhase: ((phase: Phase) => void) | undefined,
): Promise<VoiceResult> {
  const speech = prepareSpeech(textToSpeak, { maxWords: CONFIG.maxSpeakWords, maxChars: MAX_SPEAK_CHARS });
  const notes = [...speech.notes];
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "voice-mcp-"));
  const wav = path.join(tmpDir, "reply.wav");
  try {
    const t0 = Date.now();
    onPhase?.("speaking");
    const spoken = await speak(speech.text, signal);
    const spoke = Date.now() - t0;
    const fallback = fallbackNote(spoken);
    if (fallback) notes.push(fallback);
    onPhase?.("listening");
    const tListen = Date.now();
    // The chime plays once the mic is really recording, so the first word is never lost.
    const heard = await listenForTurn(seconds, wav, signal, { onListening: () => chime("start") });
    void chime("stop");
    const t1 = Date.now();
    debug("listen:", heard);
    const timing = (transcribedMs?: number) =>
      timingNote({ spokeMs: spoke, spoken, listenedMs: t1 - tListen, talkedSeconds: heard.speechSeconds, transcribedMs });

    if (heard.digitalSilence) {
      resetWhichCache(); // if the user fixes it by installing SoX, the next turn picks it up
      const viaFfmpeg = findRecorder()?.kind === "ffmpeg";
      return {
        ok: false,
        text: viaFfmpeg
          ? "The microphone returned pure digital silence. voice-mcp is recording with ffmpeg because SoX isn't installed, " +
            "and ffmpeg may be using a silent or wrong input device (for example after connecting Bluetooth headphones). " +
            "Suggest `brew install sox` (or call voice_setup), then try again. If that doesn't help: " +
            MIC_PERMISSION_HINT
          : `The microphone returned pure digital silence, which usually means microphone access is blocked. ${MIC_PERMISSION_HINT}`,
        notes,
      };
    }
    const waited = Math.min(CONFIG.startTimeoutSeconds, seconds);
    const noSpeech =
      `(No speech detected — the user did not reply within ${waited} seconds. The microphone is now off. ` +
      "Ask once more out loud. If there's still no answer, stop and say on screen that voice mode is paused " +
      "and they can type anything to carry on — speaking won't work until you call speak_and_listen again.)";
    if (heard.reason === "no-speech") return { ok: true, text: noSpeech, notes: [...notes, timing()] };

    onPhase?.("transcribing");
    const transcript = await transcribe(wav, model, signal);
    const transcribed = Date.now() - t1;
    if (!transcript) {
      // Something was loud enough to sound like speech (a cough, typing, a door), but whisper found no words in it.
      // Starts with "(No speech detected" so the plugin's voice-mode hook knows the user wasn't heard.
      const noWords =
        "(No speech detected — the microphone picked up a sound but no words, probably a cough or background noise. The microphone is now off. " +
        "Ask once more out loud. If there's still no answer, stop and say on screen that voice mode is paused " +
        "and they can type anything to carry on — speaking won't work until you call speak_and_listen again.)";
      return { ok: true, text: noWords, notes: [...notes, timing(transcribed)] };
    }
    if (heard.reason === "max-duration") {
      const l = heard.levels;
      const f = (n: number) => (Number.isFinite(n) ? n.toFixed(0) : "?");
      notes.push(
        `voice-mcp note: listening stopped at the ${seconds}-second limit while the user was still talking, ` +
          "so the reply may be cut off. Ask them to continue if it seems unfinished. " +
          `(Audio levels, for tuning: background ${f(l.floorDb)} dB, voice ${f(l.speechDb)} dB, ` +
          `last second ${f(l.recentDb)} ± ${l.recentSpreadDb.toFixed(1)} dB.)`,
      );
    }
    return { ok: true, text: transcript, notes: [...notes, timing(transcribed)], heard: true };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Kokoro failures already reported in this session: say each once, not on every turn. */
const reportedFallbacks = new Set<string>();

function fallbackNote(spoken: Spoken): string | null {
  if (!spoken.fallback || reportedFallbacks.has(spoken.fallback)) return null;
  reportedFallbacks.add(spoken.fallback);
  return (
    `voice-mcp note: the Kokoro voice didn't work (${spoken.fallback}), so the built-in voice spoke instead. ` +
    "Mention it to the user once; voice_setup shows what's wrong."
  );
}

/** One compact line per turn, so "why did that feel slow?" has an answer. */
export function timingNote(t: {
  spokeMs: number;
  spoken?: Spoken;
  listenedMs?: number;
  talkedSeconds?: number;
  transcribedMs?: number;
}): string {
  const k = t.spoken?.engine === "kokoro" && t.spoken.firstAudioMs !== undefined ? t.spoken : null;
  const parts = [`spoke ${secs(t.spokeMs)}` + (k ? ` (Kokoro, first sound after ${secs(k.firstAudioMs!)}${k.coldStart ? ", voice loaded" : ""})` : "")];
  if (t.listenedMs !== undefined) {
    const talked = t.talkedSeconds ?? 0;
    parts.push(`listened ${secs(t.listenedMs)}` + (talked > 0 ? ` (user talked ${talked.toFixed(1)} s)` : " (no speech)"));
  }
  if (t.transcribedMs !== undefined) parts.push(`transcribed ${secs(t.transcribedMs)}`);
  return `voice-mcp timing: ${parts.join(" · ")}`;
}

/** Serialize calls: there is one speaker and one microphone. */
let queue: Promise<unknown> = Promise.resolve();
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}
