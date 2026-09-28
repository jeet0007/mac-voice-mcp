/** Speaking (native TTS), the mic chimes, and listening for one conversational turn. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { CONFIG, debug, IS_MAC, IS_WIN } from "./config.js";
import { Endpointer, FRAME_BYTES, wavHeader, type EndReason, type EndpointerDiagnostics } from "./endpointer.js";
import { activeChildren, CancelledError, run, SetupError, tail, which, type RunResult } from "./proc.js";

// ---------------------------------------------------------------------------
// Text-to-speech
// ---------------------------------------------------------------------------

export function findTts(): string | null {
  if (IS_MAC) return which("say") ?? (existsSync("/usr/bin/say") ? "/usr/bin/say" : null);
  if (IS_WIN) return "powershell.exe";
  return which("espeak-ng") ?? which("espeak") ?? which("spd-say");
}

// --- Which voice (macOS) ---------------------------------------------------------------------

export interface SayVoice {
  name: string;
  locale: string;
  /** 3 = Premium, 2 = Enhanced, 1 = standard. */
  quality: number;
}

/** Parse `say -v '?'` lines such as "Ava (Premium)       en_US    # Hello! My name is Ava." */
export function parseSayVoices(output: string): SayVoice[] {
  const voices: SayVoice[] = [];
  for (const line of output.split("\n")) {
    const m = /^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]+)\s+#/.exec(line.trimEnd());
    if (!m) continue;
    const name = m[1]!.trim();
    const quality = /\(Premium\)/i.test(name) ? 3 : /\(Enhanced\)/i.test(name) ? 2 : 1;
    voices.push({ name, locale: m[2]!, quality });
  }
  return voices;
}

/**
 * The most natural installed voice for the language: Premium first, then Enhanced, preferring
 * the system's region (en_US over en_GB on a US Mac). null = none installed; keep the system voice.
 */
export function pickVoice(voices: SayVoice[], language: string, systemLocale: string): SayVoice | null {
  const lang = (language && language !== "auto" ? language : systemLocale).toLowerCase().split(/[-_]/)[0] ?? "en";
  const region = (systemLocale.split(/[-_]/)[1] ?? "").toUpperCase();
  const inRegion = (v: SayVoice) => (region && v.locale.toUpperCase().endsWith(`_${region}`) ? 1 : 0);
  const candidates = voices.filter((v) => v.quality >= 2 && v.locale.toLowerCase().startsWith(`${lang}_`));
  candidates.sort((a, b) => b.quality - a.quality || inRegion(b) - inRegion(a) || a.name.localeCompare(b.name));
  return candidates[0] ?? null;
}

export interface VoiceChoice {
  /** Passed to `say -v`; undefined = the system voice. */
  voice?: string;
  /** For voice_setup's report. */
  label: string;
  /** No Premium/Enhanced voice is installed, so a download would sound much better. */
  canUpgrade: boolean;
}

export const VOICE_UPGRADE_HINT =
  "for a much more natural voice, download a Premium one: System Settings → Accessibility → Spoken Content → " +
  "System Voice → Manage Voices… (for example English → Ava (Premium) or Zoe (Premium)). It's used automatically — no restart needed.";

let voiceChoice: Promise<VoiceChoice> | undefined;

/** Forget the choice, so a voice downloaded meanwhile is picked up (voice_setup calls this). */
export function resetVoiceChoice(): void {
  voiceChoice = undefined;
}

export function chooseVoice(): Promise<VoiceChoice> {
  voiceChoice ??= (async (): Promise<VoiceChoice> => {
    if (CONFIG.voice) {
      return CONFIG.voice.toLowerCase() === "default"
        ? { label: "the system voice (VOICE_MCP_VOICE=default)", canUpgrade: false }
        : { voice: CONFIG.voice, label: `${CONFIG.voice} (set by VOICE_MCP_VOICE)`, canUpgrade: false };
    }
    const bin = IS_MAC ? findTts() : null;
    if (!bin) return { label: "the system voice", canUpgrade: false };
    try {
      const r = await run(bin, ["-v", "?"], { timeoutMs: 10_000 });
      const locale = Intl.DateTimeFormat().resolvedOptions().locale;
      const best = pickVoice(parseSayVoices(r.stdout), CONFIG.language, locale);
      if (best) return { voice: best.name, label: `${best.name} — the most natural voice installed`, canUpgrade: false };
    } catch {
      /* fall back to the system voice */
    }
    return { label: "the system voice", canUpgrade: true };
  })();
  return voiceChoice;
}

export async function speak(text: string, signal?: AbortSignal): Promise<void> {
  if (!text) return;
  const bin = findTts();
  if (!bin) throw new SetupError("No text-to-speech engine found. Install espeak-ng (e.g. `sudo apt install espeak-ng`).");

  let result: RunResult;
  if (IS_MAC) {
    const args: string[] = [];
    const { voice } = await chooseVoice();
    if (voice) args.push("-v", voice);
    if (CONFIG.rate) args.push("-r", CONFIG.rate);
    args.push("-f", "-"); // read from stdin: no argv length limits, no flag injection
    result = await run(bin, args, { input: text, signal, timeoutMs: 180_000 });
  } else if (IS_WIN) {
    const ps =
      "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
      "$s.Speak([Console]::In.ReadToEnd())";
    result = await run(bin, ["-NoProfile", "-NonInteractive", "-Command", ps], { input: text, signal, timeoutMs: 180_000 });
  } else if (bin.endsWith("spd-say")) {
    result = await run(bin, ["-w", ` ${text}`], { signal, timeoutMs: 180_000 });
  } else {
    result = await run(bin, ["--stdin"], { input: text, signal, timeoutMs: 180_000 });
  }

  if (result.code !== 0) {
    throw new Error(`Text-to-speech failed (exit ${result.code}): ${tail(result.stderr) || "no output"}`);
  }
}

/** A short, quiet cue that the mic just opened ("start") or closed ("stop"). macOS only. */
export async function chime(kind: "start" | "stop"): Promise<void> {
  if (!CONFIG.chime || !IS_MAC) return;
  const sound = kind === "start" ? "/System/Library/Sounds/Tink.aiff" : "/System/Library/Sounds/Pop.aiff";
  if (!existsSync(sound)) return;
  try {
    await run("/usr/bin/afplay", ["-v", "0.6", sound], { timeoutMs: 3000 });
  } catch {
    /* a missing chime is never fatal */
  }
}

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

/**
 * Listen for one conversational turn and write it to `outFile` (16 kHz mono WAV).
 * Streams raw PCM from the recorder, runs the endpointer on it live, and stops the
 * recorder the moment the user finishes. Leading and trailing silence are trimmed
 * (keeping a little padding) so whisper gets just the utterance.
 */
export async function listenForTurn(maxSeconds: number, outFile: string, signal?: AbortSignal): Promise<ListenResult> {
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

  const args = recorderArgs(recorder);
  debug("exec:", recorder.bin, args.join(" "));
  const child = spawn(recorder.bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  activeChildren.add(child);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const stop = () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 1500).unref();
    };
    const safety = setTimeout(() => {
      reason ??= "max-duration";
      stop();
    }, (maxSeconds + 5) * 1000);
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
        reason = endpointer.push(frame);
      }
      pending = pending.subarray(off);
      if (reason) stop();
    });
    child.on("error", (e) => {
      clearTimeout(safety);
      activeChildren.delete(child);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(safety);
      signal?.removeEventListener("abort", onAbort);
      activeChildren.delete(child);
      resolve(code);
    });
  });

  if (signal?.aborted) throw new CancelledError();
  if (!frames.length) {
    throw new Error(
      `Recording failed (${describeRecorder(recorder)}, exit ${exitCode}). ${tail(stderr)}`.trim() +
        (IS_MAC ? `\n${MIC_PERMISSION_HINT}` : ""),
    );
  }

  const [first, last] = endpointer.trimRange(frames.length);
  const pcm = Buffer.concat(frames.slice(first, last));
  await writeFile(outFile, Buffer.concat([wavHeader(pcm.length), pcm]));

  return {
    reason: reason ?? "max-duration",
    digitalSilence: !endpointer.anyNonZero,
    speechSeconds: endpointer.speechSeconds,
    levels: endpointer.diagnostics(),
  };
}
