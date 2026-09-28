/** The round trip: speak → listen for one turn → transcribe. */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chime, findRecorder, listenForTurn, MIC_PERMISSION_HINT, RECORDER_MISSING, speak } from "./audio.js";
import { CONFIG, debug, DEFAULT_LISTEN_SECONDS, MAX_LISTEN_SECONDS, MAX_SPEAK_CHARS } from "./config.js";
import { ensureModel } from "./model.js";
import { SetupError } from "./proc.js";
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

export async function speakAndListen(
  textToSpeak: string,
  listenSeconds: number,
  signal?: AbortSignal,
  onPhase?: (phase: "speaking" | "listening" | "transcribing") => void,
): Promise<VoiceResult> {
  const seconds = Math.min(MAX_LISTEN_SECONDS, Math.max(1, Number.isFinite(listenSeconds) ? listenSeconds : DEFAULT_LISTEN_SECONDS));
  const { model } = await preflight();

  // Load the model into the warm server while we talk, so it's ready when the user finishes.
  prewarm(model);

  const speech = prepareSpeech(textToSpeak, { maxWords: CONFIG.maxSpeakWords, maxChars: MAX_SPEAK_CHARS });
  const notes = [...speech.notes];
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "voice-mcp-"));
  const wav = path.join(tmpDir, "reply.wav");
  try {
    const t0 = Date.now();
    onPhase?.("speaking");
    await speak(speech.text, signal);
    const spoke = Date.now() - t0;
    await chime("start");
    onPhase?.("listening");
    const tListen = Date.now();
    const heard = await listenForTurn(seconds, wav, signal);
    void chime("stop");
    const t1 = Date.now();
    debug("listen:", heard);
    const timing = (transcribedMs?: number) =>
      timingNote({ spokeMs: spoke, listenedMs: t1 - tListen, talkedSeconds: heard.speechSeconds, transcribedMs });

    if (heard.digitalSilence) {
      return {
        ok: false,
        text: `The microphone returned pure digital silence, which usually means microphone access is blocked. ${MIC_PERMISSION_HINT}`,
        notes,
      };
    }
    const waited = Math.min(CONFIG.startTimeoutSeconds, seconds);
    const noSpeech = `(No speech detected — the user did not reply within ${waited} seconds.)`;
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

/** One compact line per turn, so "why did that feel slow?" has an answer. */
export function timingNote(t: { spokeMs: number; listenedMs: number; talkedSeconds: number; transcribedMs?: number }): string {
  const parts = [
    `spoke ${secs(t.spokeMs)}`,
    `listened ${secs(t.listenedMs)}` + (t.talkedSeconds > 0 ? ` (user talked ${t.talkedSeconds.toFixed(1)} s)` : " (no speech)"),
  ];
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
