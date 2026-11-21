/**
 * Text → speech, independent of where it plays: the Kokoro voice as 24 kHz PCM sentence by
 * sentence, or the command line of the built-in voice (macOS `say`, espeak-ng, Windows SAPI) that
 * the audio backend runs. Also which built-in voice to use, and speech into a WAV file for doctor and tests.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { Sound } from "../audio/device.js";
import { CONFIG, IS_MAC, IS_WIN } from "../config.js";
import { wavHeader } from "../endpointer.js";
import { prepareForKokoro } from "../kokoro-text.js";
import { isKokoroInstalled, KOKORO_RATE, kokoroEnabled, kokoroWorker } from "../kokoro.js";
import { resamplePcm16, wavSeconds } from "../pcm.js";
import { CancelledError, run, SetupError, tail, which, type RunResult } from "../proc.js";

export interface Spoken {
  engine: "kokoro" | "built-in";
  /** Kokoro: from the call to the first sound. */
  firstAudioMs?: number;
  /** Kokoro: the model was loaded for this turn. */
  coldStart?: boolean;
  /** Kokoro was wanted but failed, so the built-in voice spoke instead (why). */
  fallback?: string;
}

export function findTts(): string | null {
  if (IS_MAC) return which("say") ?? (existsSync("/usr/bin/say") ? "/usr/bin/say" : null);
  if (IS_WIN) return "powershell.exe";
  return which("espeak-ng") ?? which("espeak");
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
  "it speaks with the voice chosen in System Settings → Accessibility → Spoken Content → System Voice. For a much more " +
  "natural one, pick a Premium voice there (Manage Voices… to download one, e.g. English → Ava (Premium)), or set " +
  "VOICE_MCP_VOICE=best to use the most natural voice installed.";

let voiceChoice: Promise<VoiceChoice> | undefined;

/** Forget the choice, so a voice downloaded meanwhile is picked up (voice_setup calls this). */
export function resetVoiceChoice(): void {
  voiceChoice = undefined;
}

export function chooseVoice(): Promise<VoiceChoice> {
  voiceChoice ??= (async (): Promise<VoiceChoice> => {
    // Unset or "default": the voice chosen in System Settings (say without -v). "best": the most natural one installed.
    const wanted = CONFIG.voice?.toLowerCase();
    if (!wanted || wanted === "default") return { label: "the system voice (System Settings → Spoken Content)", canUpgrade: IS_MAC };
    if (wanted !== "best") return { voice: CONFIG.voice, label: `${CONFIG.voice} (set by VOICE_MCP_VOICE)`, canUpgrade: false };
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

// --- The built-in voice ----------------------------------------------------------------------

/**
 * The built-in voice's command, for the audio backend that plays it. Every engine reads the text
 * from stdin, so one can start ahead of time and wait for it. `standby`: keep one waiting.
 */
export async function builtInCommand(): Promise<{ bin: string; args: string[]; standby: boolean }> {
  const bin = findTts();
  if (!bin) throw new SetupError("No text-to-speech engine found. Install espeak-ng (e.g. `sudo apt install espeak-ng`).");
  // With Kokoro in use the built-in voice only fills in, so none is kept waiting for the next reply.
  const standby = CONFIG.voiceStandby && !kokoroEnabled();
  if (IS_MAC) {
    const args: string[] = [];
    const { voice } = await chooseVoice();
    if (voice) args.push("-v", voice);
    if (CONFIG.rate) args.push("-r", CONFIG.rate);
    args.push("-f", "-"); // read from stdin: no argv length limits, no flag injection
    return { bin, args, standby };
  }
  if (IS_WIN) {
    const ps =
      "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
      "$s.Speak([Console]::In.ReadToEnd())";
    return { bin, args: ["-NoProfile", "-NonInteractive", "-Command", ps], standby };
  }
  return { bin, args: ["--stdin"], standby };
}

// --- Kokoro ----------------------------------------------------------------------------------

/** A short pause between sentences, so they don't run into each other. */
const GAP_MS = 120;
const silence = (ms: number) => Buffer.alloc(Math.round((KOKORO_RATE * ms) / 1000) * 2);

export interface KokoroSpeech {
  /** Loads the model, then the sound to play (null: nothing to say). Throws if Kokoro can't start. */
  load(): Promise<Sound | null>;
  /** The sentences not yet handed to the player, for the built-in voice to finish if Kokoro fails. */
  unspoken(): string;
  /** Filled in as it plays. */
  readonly stats: { firstAudioMs: number; coldStart: boolean };
}

/** `text` in the Kokoro voice: 24 kHz PCM, one buffer per sentence as soon as it's generated. */
export function kokoroSpeech(text: string, signal: AbortSignal): KokoroSpeech {
  const chunks = prepareForKokoro(text);
  const t0 = Date.now();
  const stats = { firstAudioMs: 0, coldStart: false };
  let handed = 0;

  async function* pcm(): AsyncGenerator<Buffer> {
    const ready: Buffer[] = [];
    const s: { end?: { error?: unknown }; wake?: () => void } = {};
    const cancel = new AbortController(); // the caller stopped, or the player stopped reading
    const onAbort = () => cancel.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    kokoroWorker
      .speak(
        chunks,
        (seq, audio) => {
          if (seq === 0) stats.firstAudioMs = Date.now() - t0;
          ready.push(seq < chunks.length - 1 ? Buffer.concat([audio, silence(GAP_MS)]) : audio);
          s.wake?.();
        },
        cancel.signal,
      )
      .then(
        (r) => (s.end = r.cancelled ? { error: new CancelledError() } : {}),
        (error: unknown) => (s.end = { error }),
      )
      .finally(() => s.wake?.());
    try {
      for (;;) {
        const next = ready.shift();
        if (next) {
          handed++;
          yield next;
        } else if (s.end) {
          if (s.end.error) throw s.end.error;
          return;
        } else {
          await new Promise<void>((resolve) => (s.wake = resolve));
        }
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (!s.end) cancel.abort();
    }
  }

  return {
    stats,
    unspoken: () => chunks.slice(handed).join(" "),
    async load() {
      if (!chunks.length) return null;
      if (!isKokoroInstalled()) throw new SetupError("the Kokoro voice isn't installed — call voice_setup with kokoro=true");
      if (signal.aborted) throw new CancelledError();
      stats.coldStart = !kokoroWorker.running;
      await kokoroWorker.start();
      if (signal.aborted) throw new CancelledError();
      return { kind: "speech", chunks: pcm() };
    },
  };
}

// --- Into a file -----------------------------------------------------------------------------

/**
 * Speak `text` into a 16 kHz mono 16-bit WAV instead of the speakers, with the same voice
 * replies use. For `doctor` and the round-trip tests. A Kokoro failure is an error here, not a fallback.
 */
export async function synthesizeToFile(text: string, outFile: string): Promise<Spoken> {
  if (kokoroEnabled()) return { engine: "kokoro", ...(await kokoroToFile(text, outFile)) };
  const bin = findTts();
  if (!bin) throw new SetupError("No text-to-speech engine found.");
  const { voice } = IS_MAC ? await chooseVoice() : { voice: undefined };
  const once = async (): Promise<number> => {
    let result: RunResult;
    if (IS_MAC) {
      const args = [...(voice ? ["-v", voice] : []), "-o", outFile, "--file-format=WAVE", "--data-format=LEI16@16000", "-f", "-"];
      result = await run(bin, args, { input: text, timeoutMs: 60_000 });
    } else if (/espeak/.test(bin)) {
      result = await run(bin, ["-w", outFile, "--stdin"], { input: text, timeoutMs: 60_000 });
    } else {
      throw new SetupError("Writing speech to a file needs macOS `say` or espeak-ng.");
    }
    if (result.code !== 0) throw new Error(`Text-to-speech to file failed (exit ${result.code}): ${tail(result.stderr) || "no output"}`);
    return wavSeconds(await readFile(outFile));
  };
  // Sometimes `say` exits fine but writes (almost) no audio, e.g. when the voice's speech data
  // isn't available. Try once more, then say so plainly instead of handing silence to whisper.
  const expected = text.trim().split(/\s+/).length > 2;
  let seconds = await once();
  if (expected && seconds < 0.3) seconds = await once();
  if (expected && seconds < 0.3) {
    throw new Error(
      `Text-to-speech wrote only ${seconds.toFixed(2)} s of audio for "${text.slice(0, 40)}…" with ${voice ? `the voice "${voice}"` : "the system voice"}. ` +
        "That voice may be missing its speech data: pick another with VOICE_MCP_VOICE (list them with `say -v '?'`).",
    );
  }
  return { engine: "built-in" };
}

async function kokoroToFile(text: string, outFile: string): Promise<{ firstAudioMs: number; coldStart: boolean }> {
  const chunks = prepareForKokoro(text);
  if (!isKokoroInstalled()) throw new SetupError("the Kokoro voice isn't installed — call voice_setup with kokoro=true");
  const t0 = Date.now();
  const coldStart = !kokoroWorker.running;
  await kokoroWorker.start();
  const parts: Buffer[] = [];
  let firstAudioMs = 0;
  await kokoroWorker.speak(chunks, (seq, pcm) => {
    if (seq === 0) firstAudioMs = Date.now() - t0;
    parts[seq] = seq < chunks.length - 1 ? Buffer.concat([pcm, silence(GAP_MS)]) : pcm;
  });
  const pcm16k = resamplePcm16(Buffer.concat(parts), KOKORO_RATE, 16_000);
  await writeFile(outFile, Buffer.concat([wavHeader(pcm16k.length), pcm16k]));
  return { firstAudioMs, coldStart };
}
