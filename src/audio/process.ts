// The process backend: recorder and player programs, SIGSTOP pause, and headphone detection. See docs/specs/audio.md.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CONFIG, debug, IS_MAC, IS_WIN, log } from "../config.js";
import { FRAME_BYTES, wavHeader } from "../endpointer.js";
import { activeChildren, CancelledError, isExecutable, run, SetupError, startWaiting, tail, which, type Waiting } from "../proc.js";
import { builtInCommand } from "../speech/synthesize.js";
import { SPEECH_RATE, type Playback, type PlayEnd, type Sound } from "./device.js";

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
    return ["-q", "-V1", ...(r.viaSox ? ["-d"] : []), "-t", "raw", "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", "-"];
  }
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-f", "avfoundation", "-i", CONFIG.ffmpegDevice,
    "-ac", "1", "-ar", "16000", "-f", "s16le", "-",
  ];
}

export interface Recording {
  readonly frames: AsyncIterableIterator<Buffer>;
  stop(): void;
  readonly exited: Promise<void>;
}

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

interface Track {
  add(child: ChildProcess): void;
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
  const pause = () => {
    // No SIGSTOP on Windows: it would kill the voice.
    if (IS_WIN || ctl.signal.aborted || paused()) return;
    pausedAt = Date.now();
    signalAll("SIGSTOP");
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
    duck: (gain) => (gain >= 1 ? resume() : pause()),
    pause,
    resume,
    stop() {
      if (ctl.signal.aborted) return;
      resume(); // a stopped process can't act on SIGTERM
      ctl.abort();
    },
    playedMs: () => Date.now() - startedAt - pausedMs - (paused() ? Date.now() - pausedAt : 0),
  };
}

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

let standby: { key: string; proc: Waiting } | null = null;
let standbyTimer: NodeJS.Timeout | undefined;

function takeStandby(key: string): Waiting | null {
  const s = standby;
  standby = null;
  clearTimeout(standbyTimer);
  if (!s) return null;
  if (s.key === key && s.proc.ready) return s.proc;
  s.proc.kill();
  return null;
}

function prepareStandby(bin: string, args: string[]): void {
  const key = [bin, ...args].join("\0");
  if (standby?.key === key && standby.proc.ready) return;
  takeStandby("");
  standby = { key, proc: startWaiting(bin, args) };
  standbyTimer = setTimeout(() => takeStandby(""), CONFIG.serverIdleMinutes * 60_000);
  standbyTimer.unref();
}

async function voice(text: string, t: Track): Promise<void> {
  const { bin, args, standby } = await builtInCommand();
  const opts = { signal: t.signal, timeoutMs: 180_000, onProcess: (child: ChildProcess) => t.add(child) };
  const ready = takeStandby([bin, ...args].join("\0"));
  const result = ready ? await ready.send(text, opts) : await run(bin, args, { ...opts, input: text });
  if (standby) prepareStandby(bin, args);
  if (result.code !== 0) throw new Error(`Text-to-speech failed (exit ${result.code}): ${tail(result.stderr) || "no output"}`);
}

async function cue(file: string, volume: number, t: Track): Promise<void> {
  const r = await run(which("afplay") ?? "/usr/bin/afplay", ["-v", String(volume), file], { timeoutMs: 3000, signal: t.signal, onProcess: (c) => t.add(c) });
  if (r.code !== 0) throw new Error(`afplay failed (exit ${r.code}): ${tail(r.stderr) || "no output"}`);
}

type ProfileItem = { _name?: string; coreaudio_default_audio_output_device?: string; coreaudio_device_transport?: string; coreaudio_output_source?: string };
function defaultOutput(json: unknown): ProfileItem | undefined {
  const groups = (json as { SPAudioDataType?: { _items?: ProfileItem[] }[] } | null)?.SPAudioDataType ?? [];
  return groups.flatMap((g) => g._items ?? []).find((i) => i.coreaudio_default_audio_output_device === "spaudio_yes");
}

export function headphonesFromProfile(json: unknown): boolean {
  const out = defaultOutput(json);
  if (!out) return false;
  if (/headphone/i.test(out.coreaudio_output_source ?? "")) return true;
  return out.coreaudio_device_transport === "coreaudio_device_type_bluetooth" && !/speaker/i.test(out._name ?? "");
}

export function speakersFromProfile(json: unknown): boolean {
  const out = defaultOutput(json);
  if (!out || headphonesFromProfile(json)) return false;
  const transport = out.coreaudio_device_transport;
  return transport === "coreaudio_device_type_builtin" || (transport === "coreaudio_device_type_usb" && /speaker/i.test(out._name ?? ""));
}

export type Output = "headphones" | "speakers" | "other";

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

export async function detectDuplex(output?: Output | null): Promise<"full" | "half"> {
  if (IS_WIN) return "half";
  if (CONFIG.callDuplex !== "auto") return CONFIG.callDuplex;
  return (output === undefined ? await outputRoute() : output) === "headphones" ? "full" : "half";
}
