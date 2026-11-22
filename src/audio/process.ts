/**
 * The process backend: the recorder (rec, sox or ffmpeg) for the mic; SoX `play` (or afplay) for
 * speech PCM, the built-in voice's own program with one started ahead of time, afplay for cues,
 * SIGSTOP/SIGCONT for a duck, and headphone detection. Internal to src/audio/: everything else goes
 * through device.ts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CONFIG, debug, IS_MAC, IS_WIN, log } from "../config.js";
import { FRAME_BYTES, wavHeader } from "../endpointer.js";
import { activeChildren, CancelledError, isExecutable, run, SetupError, startWaiting, tail, which, type Waiting } from "../proc.js";
import { builtInCommand } from "../speech/synthesize.js";
import { SPEECH_RATE, type Playback, type PlayEnd, type Sound } from "./device.js";

// ---------------------------------------------------------------------------
// The mic
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

/** One recorder process. */
export interface Recording {
  /**
   * Its audio in FRAME_BYTES slices, from the start. Ends once stopped; throws when the recorder
   * exits on its own or can't start. return() stops it without waiting for it to exit.
   */
  readonly frames: AsyncIterableIterator<Buffer>;
  /** SIGTERM, then SIGKILL if it hasn't exited after 2 s. Idempotent. */
  stop(): void;
  /** Resolves once the process is gone. */
  readonly exited: Promise<void>;
}

/** Start the recorder: the mic stays open until stop(). */
export function record(recorder: Recorder): Recording {
  const args = recorderArgs(recorder);
  debug("exec:", recorder.bin, args.join(" "));
  const child = spawn(recorder.bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  activeChildren.add(child);
  const queue: Buffer[] = [];
  let pending: Buffer = Buffer.alloc(0);
  let stderr = "";
  let delivered = false;
  let stopped = false;
  /** "done" once stopped, or why the recording failed. */
  let end: "done" | Error | null = null;
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    queue.length = 0;
    end ??= "done";
    notify();
    if (child.exitCode === null) child.kill("SIGTERM");
    setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 2000).unref();
  };
  child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
  child.stdout!.on("data", (chunk: Buffer) => {
    if (stopped) return;
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let off = 0;
    for (; pending.length - off >= FRAME_BYTES; off += FRAME_BYTES) queue.push(Buffer.from(pending.subarray(off, off + FRAME_BYTES)));
    pending = pending.subarray(off);
    if (queue.length) notify();
  });
  const exited = new Promise<void>((resolve) => {
    child.on("error", (e) => {
      activeChildren.delete(child);
      end ??= e;
      notify();
      resolve();
    });
    child.on("close", (code) => {
      activeChildren.delete(child);
      end ??= delivered
        ? new Error(`The recorder stopped (exit ${code}): ${tail(stderr) || "no output"}`)
        : new Error(`Recording failed (${describeRecorder(recorder)}, exit ${code}). ${tail(stderr)}`.trim() + (IS_MAC ? `\n${MIC_PERMISSION_HINT}` : ""));
      notify();
      resolve();
    });
  });
  const frames: AsyncIterableIterator<Buffer> = {
    [Symbol.asyncIterator]: () => frames,
    async next() {
      for (;;) {
        const frame = queue.shift();
        if (frame) {
          delivered = true;
          return { value: frame, done: false };
        }
        if (end === "done") return { value: undefined, done: true };
        if (end) throw end;
        await new Promise<void>((r) => (wake = r));
      }
    },
    async return() {
      stop();
      return { value: undefined, done: true };
    },
  };
  return { frames, stop, exited };
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

/** What a player gets from its Playback. */
interface Track {
  /** Make duck() and stop() reach `child` until it exits. */
  add(child: ChildProcess): void;
  /** Aborted by stop(). */
  readonly signal: AbortSignal;
}

export function play(sound: Sound): Playback {
  switch (sound.kind) {
    case "speech": {
      const bin = which("play");
      if (bin) return playback((t) => soxSpeech(bin, sound.chunks, t));
      if (IS_MAC && isExecutable("/usr/bin/afplay")) return playback((t) => afplaySpeech(sound.chunks, t));
      return playback(() => Promise.reject(new SetupError("The Kokoro voice needs SoX's `play` to play audio (`brew install sox`).")));
    }
    case "voice":
      return playback((t) => voice(sound.text, t));
    case "cue":
      return playback((t) => cue(sound.file, sound.volume, t));
  }
}

/**
 * One Playback over the processes `player` starts. A duck below 1 pauses them all with SIGSTOP
 * (`say` or SoX goes quiet within 200 ms; SIGCONT resumes mid-sentence), and one started while
 * paused is paused at once. A stopped process can't act on SIGTERM, so stop() resumes it first.
 */
function playback(player: (t: Track) => Promise<void>): Playback {
  const children = new Set<ChildProcess>();
  const ctl = new AbortController();
  const startedAt = Date.now();
  let pausedAt = 0;
  let pausedMs = 0;
  const paused = () => pausedAt > 0;
  const signalAll = (sig: NodeJS.Signals) => {
    for (const child of children) child.kill(sig);
  };
  const track: Track = {
    signal: ctl.signal,
    add(child) {
      children.add(child);
      child.once("close", () => children.delete(child));
      if (paused()) child.kill("SIGSTOP");
    },
  };
  const resume = () => {
    if (!paused()) return;
    pausedMs += Date.now() - pausedAt;
    pausedAt = 0;
    signalAll("SIGCONT");
  };
  const done: Promise<PlayEnd> = player(track).then(
    () => (ctl.signal.aborted ? "stopped" : "finished"),
    (err: unknown) => {
      if (ctl.signal.aborted) return "stopped";
      throw err;
    },
  );
  done.catch(() => {}); // the caller handles it; don't crash on an unobserved rejection
  return {
    done,
    duck(gain) {
      // No SIGSTOP on Windows: it would kill the voice (detectDuplex keeps calls there half duplex).
      if (IS_WIN || ctl.signal.aborted) return;
      if (gain >= 1) return resume();
      if (paused()) return;
      pausedAt = Date.now();
      signalAll("SIGSTOP");
    },
    stop() {
      if (ctl.signal.aborted) return;
      resume();
      ctl.abort();
    },
    playedMs: () => Date.now() - startedAt - pausedMs - (paused() ? Date.now() - pausedAt : 0),
  };
}

/** SoX `play`, streaming raw PCM: gapless, and starts with the first sentence. */
async function soxSpeech(bin: string, chunks: AsyncIterable<Buffer>, t: Track): Promise<void> {
  const child = spawn(bin, ["-q", "-t", "raw", "-r", String(SPEECH_RATE), "-e", "signed-integer", "-b", "16", "-c", "1", "-"], {
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true,
  });
  t.add(child);
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr = (stderr + d).slice(-2000)));
  child.stdin!.on("error", () => {});
  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  t.signal.addEventListener("abort", kill, { once: true });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  const pump = (async () => {
    for await (const pcm of chunks) {
      if (t.signal.aborted || child.exitCode !== null || child.signalCode !== null) return;
      child.stdin!.write(pcm);
    }
    child.stdin!.end();
  })();
  // The source failing stops the player at once; the player dying ends the wait for the source.
  const sourceFailed = pump.then(
    () => new Promise<never>(() => {}),
    (err: unknown) => {
      kill();
      throw err;
    },
  );
  sourceFailed.catch(() => {});
  try {
    const code = await Promise.race([closed, sourceFailed]);
    if (t.signal.aborted) throw new CancelledError();
    if (code !== 0) throw new Error(`play failed (exit ${code}): ${tail(stderr) || "no output"}`);
  } finally {
    t.signal.removeEventListener("abort", kill);
  }
}

/** macOS without SoX: one short WAV per sentence through afplay, back to back. */
async function afplaySpeech(chunks: AsyncIterable<Buffer>, t: Track): Promise<void> {
  let dir: string | undefined;
  let n = 0;
  try {
    for await (const pcm of chunks) {
      if (t.signal.aborted) break;
      dir ??= await mkdtemp(path.join(os.tmpdir(), "voice-mcp-kokoro-"));
      const file = path.join(dir, `${n++}.wav`);
      await writeFile(file, Buffer.concat([wavHeader(pcm.length, SPEECH_RATE), pcm]));
      if (t.signal.aborted) break;
      await new Promise<void>((resolve, reject) => {
        const child = spawn("/usr/bin/afplay", [file], { stdio: "ignore" });
        t.add(child);
        const kill = () => child.kill("SIGKILL");
        t.signal.addEventListener("abort", kill, { once: true });
        child.on("error", reject);
        child.on("close", (code) => {
          t.signal.removeEventListener("abort", kill);
          if (code === 0 || t.signal.aborted) resolve();
          else reject(new Error(`afplay failed (exit ${code})`));
        });
      });
    }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  if (t.signal.aborted) throw new CancelledError();
}

/**
 * The built-in voice, started ahead of time. Loading a voice takes a while (about 1.4 s for a Siri
 * voice with `say`), and the engines read the text from stdin, so one is started early and waits:
 * the next reply only has to hand it the text. Measured with Siri Voice 4: 1.4 s → 0.6 s from the
 * text to the end of the speech, beyond the audio itself. Replaced after each reply; stopped when idle.
 */
let standby: { key: string; proc: Waiting } | null = null;
let standbyTimer: NodeJS.Timeout | undefined;

function takeStandby(key: string): Waiting | null {
  const s = standby;
  standby = null;
  clearTimeout(standbyTimer);
  if (!s) return null;
  if (s.key === key && s.proc.ready) return s.proc;
  s.proc.kill(); // the voice setting changed, or it stopped
  return null;
}

function prepareStandby(bin: string, args: string[]): void {
  const key = [bin, ...args].join("\0");
  if (standby?.key === key && standby.proc.ready) return;
  takeStandby(""); // drop a stale one
  standby = { key, proc: startWaiting(bin, args) };
  standbyTimer = setTimeout(() => takeStandby(""), CONFIG.serverIdleMinutes * 60_000);
  standbyTimer.unref();
}

async function voice(text: string, t: Track): Promise<void> {
  const { bin, args, standby } = await builtInCommand();
  const opts = { signal: t.signal, timeoutMs: 180_000, onProcess: (child: ChildProcess) => t.add(child) };
  const ready = takeStandby([bin, ...args].join("\0"));
  const result = ready ? await ready.send(text, opts) : await run(bin, args, { ...opts, input: text });
  if (standby) prepareStandby(bin, args); // for the next reply
  if (result.code !== 0) throw new Error(`Text-to-speech failed (exit ${result.code}): ${tail(result.stderr) || "no output"}`);
}

async function cue(file: string, volume: number, t: Track): Promise<void> {
  const r = await run(which("afplay") ?? "/usr/bin/afplay", ["-v", String(volume), file], { timeoutMs: 3000, signal: t.signal, onProcess: (c) => t.add(c) });
  if (r.code !== 0) throw new Error(`afplay failed (exit ${r.code}): ${tail(r.stderr) || "no output"}`);
}

type ProfileItem = { _name?: string; coreaudio_default_audio_output_device?: string; coreaudio_device_transport?: string; coreaudio_output_source?: string };
/** The default output in `system_profiler SPAudioDataType -json`. */
function defaultOutput(json: unknown): ProfileItem | undefined {
  const groups = (json as { SPAudioDataType?: { _items?: ProfileItem[] }[] } | null)?.SPAudioDataType ?? [];
  return groups.flatMap((g) => g._items ?? []).find((i) => i.coreaudio_default_audio_output_device === "spaudio_yes");
}

/**
 * Does the profile say the default output is headphones? The built-in jack's headphones, or
 * Bluetooth unless its name says speaker (AirPods yes, a Bluetooth speaker no).
 */
export function headphonesFromProfile(json: unknown): boolean {
  const out = defaultOutput(json);
  if (!out) return false;
  if (/headphone/i.test(out.coreaudio_output_source ?? "")) return true;
  return out.coreaudio_device_transport === "coreaudio_device_type_bluetooth" && !/speaker/i.test(out._name ?? "");
}

/**
 * Speakers whose echo the native backend may cancel (H2's allowlist): the Mac's own, or wired ones
 * (the built-in line out, or USB that says speaker). AirPlay, HDMI and Bluetooth speakers aren't measured yet.
 */
export function speakersFromProfile(json: unknown): boolean {
  const out = defaultOutput(json);
  if (!out || headphonesFromProfile(json)) return false;
  const transport = out.coreaudio_device_transport;
  return transport === "coreaudio_device_type_builtin" || (transport === "coreaudio_device_type_usb" && /speaker/i.test(out._name ?? ""));
}

export type Output = "headphones" | "speakers" | "other";

/** Where the Mac's sound goes now ("speakers": allowlisted ones), or null when that can't be told. */
export async function outputRoute(): Promise<Output | null> {
  if (!IS_MAC) return null;
  try {
    const bin = which("system_profiler") ?? "/usr/sbin/system_profiler";
    const r = await run(bin, ["SPAudioDataType", "-json"], { timeoutMs: 5000 });
    if (r.code !== 0) throw new Error(`exit ${r.code}: ${tail(r.stderr) || "no output"}`);
    const profile: unknown = JSON.parse(r.stdout);
    return headphonesFromProfile(profile) ? "headphones" : speakersFromProfile(profile) ? "speakers" : "other";
  } catch (e) {
    log(`Couldn't tell whether headphones are on, so the call mutes the mic while Claude speaks: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Can a call keep the mic open while Claude speaks? VOICE_MCP_CALL_DUPLEX, or for auto: full on
 * headphones (no echo to hear back), half otherwise. Never full where speech can't be paused (Windows).
 * `output`: the route, when the caller already has it.
 */
export async function detectDuplex(output?: Output | null): Promise<"full" | "half"> {
  if (IS_WIN) return "half";
  if (CONFIG.callDuplex !== "auto") return CONFIG.callDuplex;
  return (output === undefined ? await outputRoute() : output) === "headphones" ? "full" : "half";
}
