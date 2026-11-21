/** Listening: one conversational turn, a whole call, or a fixed recording. */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG, debug, IS_MAC, IS_WIN } from "./config.js";
import { Endpointer, FRAME_BYTES, FRAME_MS, wavHeader, type EndReason, type EndpointerDiagnostics } from "./endpointer.js";
import { flightAudio, flightEvent } from "./flight.js";
import { utteranceFrames, type LiveTranscript } from "./live-transcript.js";
import { activeChildren, CancelledError, SetupError, tail, which } from "./proc.js";

// ---------------------------------------------------------------------------
// Listening
// ---------------------------------------------------------------------------

export type Recorder = { kind: "sox"; bin: string; viaSox: boolean } | { kind: "ffmpeg"; bin: string };

export function findRecorder(): Recorder | null {
  const pref = CONFIG.recorder;
  if (pref !== "ffmpeg") {
    const rec = which("rec");
    if (rec) return { kind: "sox", bin: rec, viaSox: false };
    const sox = which("sox");
    if (sox) return { kind: "sox", bin: sox, viaSox: true };
  }
  if (pref !== "sox" && IS_MAC) {
    const ffmpeg = which("ffmpeg");
    if (ffmpeg) return { kind: "ffmpeg", bin: ffmpeg };
  }
  return null;
}

export function describeRecorder(r: Recorder): string {
  return `${r.kind === "sox" ? "SoX" : "ffmpeg"} (${r.bin})`;
}

export const RECORDER_MISSING =
  "No audio recorder found. Call the voice_setup tool to check and install what's missing " +
  (IS_WIN ? "(or install SoX from https://sourceforge.net/projects/sox/)." : "(or run `brew install sox`).");

export const MIC_PERMISSION_HINT =
  "Allow microphone access for the app running this server (Claude, Cursor, Terminal, iTerm, VS Code …) " +
  "in System Settings → Privacy & Security → Microphone, then restart that app.";

export interface ListenResult {
  reason: EndReason;
  /** The microphone delivered nothing but exact zeros — almost always a permission block. */
  digitalSilence: boolean;
  /** Seconds of voiced audio detected. */
  speechSeconds: number;
  /** Audio levels behind the decision, for tuning. */
  levels: EndpointerDiagnostics;
  /** The trimmed utterance as a complete 16 kHz mono WAV, so it can be transcribed without a file. */
  wav: Buffer;
  /**
   * Resolves once the recorder process has exited. listenForTurn returns as soon as the turn is
   * decided, while the recorder is still being stopped: hold the mic lock until this resolves.
   */
  recorderExited: Promise<void>;
}

function recorderArgs(r: Recorder): string[] {
  if (r.kind === "sox") {
    // Raw 16 kHz mono s16le to stdout; SoX resamples from the device rate.
    return ["-q", "-V1", ...(r.viaSox ? ["-d"] : []), "-t", "raw", "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", "-"];
  }
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-f", "avfoundation", "-i", CONFIG.ffmpegDevice,
    "-ac", "1", "-ar", "16000", "-f", "s16le", "-",
  ];
}

export interface RecordResult {
  /** Nothing but exact zeros — a permission block or a dead input device. */
  digitalSilence: boolean;
  /** Loudest 30 ms frame, in dBFS. */
  peakDb: number;
}

/**
 * Record exactly `seconds` from the microphone into `outFile` (16 kHz mono WAV), no turn-taking.
 * `onStarted` fires once audio is actually flowing, so a caller can start playback in sync.
 */
export async function recordForSeconds(seconds: number, outFile: string, onStarted?: () => void): Promise<RecordResult> {
  const recorder = findRecorder();
  if (!recorder) throw new SetupError(RECORDER_MISSING);
  const chunks: Buffer[] = [];
  let bytes = 0;
  let stderr = "";
  const wanted = Math.round(seconds * 16000) * 2;
  const child = spawn(recorder.bin, recorderArgs(recorder), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  activeChildren.add(child);
  await new Promise<void>((resolve, reject) => {
    const stop = () => child.exitCode === null && child.kill("SIGTERM");
    const safety = setTimeout(stop, (seconds + 10) * 1000);
    child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
    child.stdout!.on("data", (chunk: Buffer) => {
      if (bytes === 0) onStarted?.();
      if (bytes >= wanted) return;
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes >= wanted) stop();
    });
    child.on("error", (e) => {
      clearTimeout(safety);
      activeChildren.delete(child);
      reject(e);
    });
    child.on("close", () => {
      clearTimeout(safety);
      activeChildren.delete(child);
      resolve();
    });
  });
  const pcm = Buffer.concat(chunks).subarray(0, wanted - (wanted % 2));
  if (!pcm.length) throw new Error(`Recording failed (${describeRecorder(recorder)}). ${tail(stderr)}`.trim());
  await writeFile(outFile, Buffer.concat([wavHeader(pcm.length), pcm]));

  let peak = 0;
  let anyNonZero = false;
  for (let off = 0; off + FRAME_BYTES <= pcm.length; off += FRAME_BYTES) {
    let sum = 0;
    for (let i = off; i < off + FRAME_BYTES; i += 2) {
      const v = pcm.readInt16LE(i);
      if (v !== 0) anyNonZero = true;
      sum += v * v;
    }
    peak = Math.max(peak, sum / (FRAME_BYTES / 2));
  }
  return { digitalSilence: !anyNonZero, peakDb: peak > 0 ? 10 * Math.log10(peak / 32768 ** 2) : -Infinity };
}

/** Audio the mic must have delivered before we tell the user it's open: the recorder is running, and the room's level is known. */
export const MIC_WARMUP_MS = 250;

export interface ListenOptions {
  /**
   * Called once the microphone is really recording (after MIC_WARMUP_MS of audio), to tell the
   * user to talk — the "mic open" chime. While its promise is pending, the sound it makes is ignored.
   */
  onListening?: () => Promise<unknown> | void;
  /**
   * Called right after the recorder is spawned, with a promise that resolves once it has exited.
   * It reaches the caller on every path (also when the turn is cancelled and listenForTurn throws),
   * so a mic lock or a next recorder can wait for the old one to be really gone.
   */
  onRecorder?: (exited: Promise<void>) => void;
}

/**
 * Listen for one conversational turn: the utterance comes back as `wav` (16 kHz mono WAV), and is
 * also written to `outFile` when one is given.
 * Streams raw PCM from the recorder, runs the endpointer on it live, and stops the
 * recorder the moment the user finishes. Leading and trailing silence are trimmed
 * (keeping a little padding) so whisper gets just the utterance.
 *
 * The recorder starts first and `onListening` (the chime) comes only once audio is flowing, so
 * someone who starts talking right at the chime is never cut off: opening a mic takes a moment,
 * longer with Bluetooth.
 */
export async function listenForTurn(maxSeconds: number, outFile: string | null, signal?: AbortSignal, opts: ListenOptions = {}): Promise<ListenResult> {
  const recorder = findRecorder();
  if (!recorder) throw new SetupError(RECORDER_MISSING);

  const endpointer = new Endpointer({
    maxMs: maxSeconds * 1000,
    startTimeoutMs: CONFIG.startTimeoutSeconds * 1000,
    endSilenceMs: CONFIG.endSilenceMs,
    marginDb: CONFIG.speechMarginDb,
    minSpeechDb: CONFIG.minSpeechDb,
  });

  const frames: Buffer[] = [];
  let pending: Buffer = Buffer.alloc(0);
  let reason: EndReason | null = null;
  let stderr = "";
  const warmupFrames = Math.ceil(MIC_WARMUP_MS / FRAME_MS);
  let announced = false;
  const announce = () => {
    announced = true;
    if (!opts.onListening) return;
    endpointer.setIgnoring(true);
    Promise.resolve()
      .then(opts.onListening)
      .catch(() => {})
      // A short tail: the chime's echo fades out of the mic a moment after it ends.
      .finally(() => setTimeout(() => endpointer.setIgnoring(false), 80));
  };

  const args = recorderArgs(recorder);
  debug("exec:", recorder.bin, args.join(" "));
  const child = spawn(recorder.bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  activeChildren.add(child);
  const listenedAt = Date.now();
  flightEvent("listen.start", {
    mode: "turn",
    maxMs: maxSeconds * 1000,
    endSilenceMs: CONFIG.endSilenceMs,
    marginDb: CONFIG.speechMarginDb,
    minSpeechDb: CONFIG.minSpeechDb,
    chime: !!opts.onListening && CONFIG.chime,
  });

  let markExited!: () => void;
  const recorderExited = new Promise<void>((r) => (markExited = r));
  opts.onRecorder?.(recorderExited);
  // Resolves with the exit code, or "decided" as soon as the turn is over and there is audio:
  // the recorder is stopped in the background, and nothing waits for it to exit.
  const exitCode = await new Promise<number | null | "decided">((resolve, reject) => {
    const stop = () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 1500).unref();
    };
    const safety = setTimeout(() => {
      reason ??= "max-duration";
      stop();
      if (frames.length) resolve("decided");
    }, (Math.min(CONFIG.startTimeoutSeconds, maxSeconds) + maxSeconds + 5) * 1000); // wait for speech + talking time + slack
    const onAbort = () => stop();
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
    child.stdout!.on("data", (chunk: Buffer) => {
      if (reason) return;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let off = 0;
      while (!reason && pending.length - off >= FRAME_BYTES) {
        const frame = Buffer.from(pending.subarray(off, off + FRAME_BYTES));
        off += FRAME_BYTES;
        frames.push(frame);
        flightAudio(frame);
        reason = endpointer.push(frame);
        if (!announced && frames.length >= warmupFrames) announce();
      }
      pending = pending.subarray(off);
      if (reason) {
        stop();
        resolve("decided");
      }
    });
    child.on("error", (e) => {
      clearTimeout(safety);
      activeChildren.delete(child);
      markExited();
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(safety);
      signal?.removeEventListener("abort", onAbort);
      activeChildren.delete(child);
      markExited();
      resolve(code);
    });
  });

  const ended = (why: string) =>
    flightEvent("listen.end", {
      reason: why,
      totalMs: Date.now() - listenedAt,
      speechMs: Math.round(endpointer.speechSeconds * 1000),
      ...endpointer.diagnostics(),
    });
  if (signal?.aborted) {
    ended("stopped");
    throw new CancelledError();
  }
  if (!frames.length) {
    ended("error");
    throw new Error(
      `Recording failed (${describeRecorder(recorder)}, exit ${exitCode}). ${tail(stderr)}`.trim() +
        (IS_MAC ? `\n${MIC_PERMISSION_HINT}` : ""),
    );
  }

  const [first, last] = endpointer.trimRange(frames.length);
  const pcm = Buffer.concat(frames.slice(first, last));
  const wav = Buffer.concat([wavHeader(pcm.length), pcm]);
  if (outFile) await writeFile(outFile, wav);

  ended(reason ?? "max-duration");
  return {
    reason: reason ?? "max-duration",
    digitalSilence: !endpointer.anyNonZero,
    speechSeconds: endpointer.speechSeconds,
    levels: endpointer.diagnostics(),
    wav,
    recorderExited,
  };
}

/** Speech this long while Claude speaks is the user talking over it (Pipecat waits 200 ms, LiveKit 500 ms; 150 ms is too eager). */
export const BARGE_IN_MS = 250;

/** One utterance is at most this long; after this much silence the endpointer is started afresh, so nothing piles up. */
const UTTERANCE_MAX_MS = 60_000;

export interface ContinuousOptions {
  /** Frames are dropped while this is true (our own speech is playing: half duplex). */
  muted: () => boolean;
  /** Each utterance, as a trimmed 16 kHz mono WAV in `dir`, in order. Not awaited. */
  onUtterance: (wav: string) => void;
  /** Each heard (unmuted) frame's level and the speech threshold it was judged against, in dBFS. */
  onLevel?: (db: number, thresholdDb: number) => void;
  /** true once the user has talked for BARGE_IN_MS, false when that utterance ends or turns out to be a blip. */
  onSpeech?: (talking: boolean) => void;
  /** Gets every heard frame, to ask for rough transcripts while the user talks (src/live-transcript.ts). */
  live?: LiveTranscript;
  dir: string;
}

/**
 * Keep the mic open until `signal` aborts (one recorder for the whole call), cutting what it hears
 * into utterances with a fresh Endpointer each: no start timeout, so silence never ends it.
 * Rejects if the recorder stops on its own.
 */
export async function listenContinuously(signal: AbortSignal, opts: ContinuousOptions): Promise<void> {
  const recorder = findRecorder();
  if (!recorder) throw new SetupError(RECORDER_MISSING);
  const fresh = () =>
    new Endpointer({
      maxMs: UTTERANCE_MAX_MS,
      startTimeoutMs: UTTERANCE_MAX_MS,
      endSilenceMs: CONFIG.endSilenceMs,
      marginDb: CONFIG.speechMarginDb,
      minSpeechDb: CONFIG.minSpeechDb,
    });
  let endpointer = fresh();
  flightEvent("listen.start", { mode: "call", maxMs: UTTERANCE_MAX_MS, endSilenceMs: CONFIG.endSilenceMs, marginDb: CONFIG.speechMarginDb, minSpeechDb: CONFIG.minSpeechDb, chime: false }, null);
  let frames: Buffer[] = [];
  let pending: Buffer = Buffer.alloc(0);
  let count = 0;
  let talking = false;
  let stderr = "";

  const args = recorderArgs(recorder);
  debug("exec:", recorder.bin, args.join(" "));
  const child = spawn(recorder.bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  activeChildren.add(child);
  const stop = () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 2000).unref();
  };
  if (signal.aborted) stop();
  signal.addEventListener("abort", stop, { once: true });

  child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
  child.stdout!.on("data", (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let off = 0;
    while (pending.length - off >= FRAME_BYTES) {
      const frame = Buffer.from(pending.subarray(off, off + FRAME_BYTES));
      off += FRAME_BYTES;
      if (opts.muted()) {
        // Whatever was being said is cut: the speaker's echo would end up in it anyway.
        if (frames.length) {
          if (endpointer.speaking) flightEvent("listen.cut", { speechMs: Math.round(endpointer.speechSeconds * 1000) }, null);
          endpointer = fresh();
          frames = [];
          opts.live?.end();
        }
      } else {
        frames.push(frame);
        flightAudio(frame);
        const reason = endpointer.push(frame);
        opts.onLevel?.(endpointer.lastDb, endpointer.lastThresholdDb);
        if (!reason && opts.live && endpointer.speaking) {
          opts.live.frame(endpointer.speechSeconds, endpointer.quietMs, () => {
            const pcm = Buffer.concat(utteranceFrames(frames, endpointer.speechStartFrame));
            return Buffer.concat([wavHeader(pcm.length), pcm]);
          });
        }
        if (reason) {
          flightEvent("listen.end", { mode: "call", reason, totalMs: frames.length * FRAME_MS, speechMs: Math.round(endpointer.speechSeconds * 1000), ...endpointer.diagnostics() }, null);
          opts.live?.end(); // before onUtterance: a partial still out is dropped, the final goes alone
          if (reason !== "no-speech") {
            const [first, last] = endpointer.trimRange(frames.length);
            const pcm = Buffer.concat(frames.slice(first, last));
            const wav = path.join(opts.dir, `${++count}.wav`);
            writeFileSync(wav, Buffer.concat([wavHeader(pcm.length), pcm]));
            opts.onUtterance(wav);
          }
          endpointer = fresh();
          frames = [];
        }
      }
      const now = endpointer.speechSeconds * 1000 >= BARGE_IN_MS;
      if (now !== talking) opts.onSpeech?.((talking = now));
    }
    pending = pending.subarray(off);
  });

  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", (err) => {
      activeChildren.delete(child);
      reject(err);
    });
    child.on("close", (c) => {
      activeChildren.delete(child);
      resolve(c);
    });
  }).finally(() => signal.removeEventListener("abort", stop));
  if (!signal.aborted) throw new Error(`The recorder stopped (exit ${code}): ${tail(stderr) || "no output"}`);
}
