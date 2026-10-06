/** The round trip: speak → listen for one turn → transcribe. */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chime, findRecorder, listenForTurn, MIC_PERMISSION_HINT, RECORDER_MISSING, speak, type Spoken } from "./audio.js";
import { CONFIG, debug, DEFAULT_LISTEN_SECONDS, MAX_LISTEN_SECONDS, MAX_SPEAK_CHARS } from "./config.js";
import { acquireMicLock, MicBusyError } from "./lock.js";
import { ensureModel } from "./model.js";
import { resetWhichCache, SetupError } from "./proc.js";
import { prepareSpeech } from "./speech-text.js";
import { findWhisperCli, findWhisperServer, prewarm, STT_MISSING, transcribe } from "./stt.js";

export interface VoiceResult {
  ok: boolean;
  text: string;
  notes: string[];
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

export async function speakAndListen(textToSpeak: string, opts: SpeakOptions = {}): Promise<VoiceResult> {
  const { signal, onPhase } = opts;
  const listen = opts.listen !== false;
  const requested = opts.listenSeconds ?? DEFAULT_LISTEN_SECONDS;
  const seconds = Math.min(MAX_LISTEN_SECONDS, Math.max(1, Number.isFinite(requested) ? requested : DEFAULT_LISTEN_SECONDS));
  const model = listen ? (await preflight()).model : null;
  // Load the model into the warm server now, so it's ready when the user finishes (even if we wait below).
  if (model) prewarm(model);

  // Wait for any other voice session on this Mac to finish with the speaker and mic.
  let release: () => void;
  try {
    release = await acquireMicLock({ signal, onWait: () => onPhase?.("waiting") });
  } catch (err) {
    if (err instanceof MicBusyError) return { ok: false, text: err.message, notes: [] };
    throw err;
  }
  try {
    return await turn(textToSpeak, seconds, model, signal, onPhase);
  } finally {
    release();
  }
}

async function turn(
  textToSpeak: string,
  seconds: number,
  model: string | null,
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
    if (!model) {
      const text = "(Spoken. The microphone was not opened, because listen was false.)";
      return { ok: true, text, notes: [...notes, timingNote({ spokeMs: spoke, spoken })] };
    }
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
    if (!transcript) return { ok: true, text: noSpeech, notes: [...notes, timing(transcribed)] };
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
    return { ok: true, text: transcript, notes: [...notes, timing(transcribed)] };
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
