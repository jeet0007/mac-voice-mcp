/**
 * The optional Kokoro voice: a natural-sounding, on-device neural voice (Kokoro-82M, Apache-2.0).
 *
 * Off until the user installs it (voice_setup with kokoro=true): that installs kokoro-js with npm
 * into ~/.cache/mac-voice-mcp/kokoro and downloads the model once. Nothing is bundled with this
 * package, and nothing is ever downloaded without that consent.
 *
 * The model runs in a separate worker process (kokoro-worker.ts), kept warm between turns and
 * stopped after VOICE_MCP_SERVER_IDLE_MINUTES. Text is spoken sentence by sentence: the first
 * sentence plays while the next ones are generated, through SoX's `play` (gapless), or `afplay`.
 *
 * Any failure falls back to the built-in voice (see speak() in audio.ts), so a broken Kokoro
 * install can never make the server mute.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { CONFIG, debug, IS_MAC, log } from "./config.js";
import { prepareForKokoro } from "./kokoro-text.js";
import { resamplePcm16, wavHeaderFor } from "./pcm.js";
import { CancelledError, isExecutable, run, SetupError, tail, which } from "./proc.js";

/** The kokoro-js release we install and test against. */
export const KOKORO_JS_VERSION = "1.2.1";
export const KOKORO_RATE = 24_000;
/** Approximate model download sizes. */
export const KOKORO_SIZES_MB = { fp32: 326, q8: 92 } as const;
/** A short pause between sentences, so they don't run into each other. */
const GAP_MS = 120;
/** Restart the worker once it holds this much memory (onnxruntime can grow over a long session). */
const RECYCLE_RSS_MB = 1500;
/** A model already on disk loads in a few seconds; allow for a slow, busy machine. */
const LOAD_TIMEOUT_MS = 120_000;
/** First install: the download may be slow. */
const INSTALL_LOAD_TIMEOUT_MS = 30 * 60_000;

const ENTRY_MJS =
  "// Written by mac-voice-mcp: lets its Kokoro worker load kokoro-js and share transformers' settings.\n" +
  'export { KokoroTTS } from "kokoro-js";\n' +
  'export { env } from "@huggingface/transformers";\n';

export function kokoroFiles() {
  const dir = CONFIG.kokoroDir;
  const modelDir = path.join(dir, "models", "onnx-community", "Kokoro-82M-v1.0-ONNX", "onnx");
  return {
    dir,
    entry: path.join(dir, "entry.mjs"),
    pkg: path.join(dir, "node_modules", "kokoro-js", "package.json"),
    model: path.join(modelDir, CONFIG.kokoroDtype === "q8" ? "model_quantized.onnx" : "model.onnx"),
  };
}

/** kokoro-js is installed (the model may still be missing). */
export function isKokoroInstalled(): boolean {
  const f = kokoroFiles();
  return existsSync(f.entry) && existsSync(f.pkg);
}

/** The model for the configured precision is on disk. */
export function isKokoroModelPresent(): boolean {
  return existsSync(kokoroFiles().model);
}

/** Speak with Kokoro? Yes when the user installed it (VOICE_MCP_TTS=auto) or asked for it (=kokoro). */
export function kokoroEnabled(): boolean {
  if (CONFIG.tts === "say") return false;
  if (CONFIG.tts === "kokoro") return true;
  return isKokoroInstalled() && isKokoroModelPresent();
}

/** Kokoro failed partway: what hadn't been spoken yet, so the built-in voice can finish it. */
export class KokoroError extends Error {
  override name = "KokoroError";
  constructor(
    message: string,
    readonly unspoken: string[],
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// The worker process
// ---------------------------------------------------------------------------

interface Ready {
  voice: string;
  voices: string[];
  loadMs: number;
}

interface Request {
  onAudio: (seq: number, pcm: Buffer) => void;
  resolve: (r: { rssMb: number; cancelled: boolean }) => void;
  reject: (e: Error) => void;
}

class KokoroWorker {
  private child: ChildProcess | null = null;
  private ready: Promise<Ready> | null = null;
  private requests = new Map<string, Request>();
  private idleTimer: NodeJS.Timeout | undefined;
  private nextId = 1;
  private logTail = "";
  info: Ready | null = null;
  onProgress: ((message: string) => void) | undefined;

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Start (or reuse) the worker; resolves once the model is loaded. */
  start(opts: { allowDownload?: boolean } = {}): Promise<Ready> {
    this.touch();
    if (this.ready && this.running) return this.ready;
    const script = fileURLToPath(new URL("./kokoro-worker.js", import.meta.url));
    const child = spawn(process.execPath, [script], {
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        KOKORO_DIR: CONFIG.kokoroDir,
        KOKORO_DTYPE: CONFIG.kokoroDtype,
        KOKORO_VOICE: CONFIG.kokoroVoice,
        KOKORO_SPEED: String(CONFIG.kokoroSpeed),
        KOKORO_ALLOW_DOWNLOAD: opts.allowDownload ? "1" : "0",
      },
    });
    this.child = child;
    this.logTail = "";
    debug("kokoro: starting worker");
    const keepLog = (d: string) => {
      this.logTail = (this.logTail + d).slice(-3000);
      debug("kokoro:", d.trimEnd());
    };
    child.stdout!.setEncoding("utf8").on("data", keepLog);
    child.stderr!.setEncoding("utf8").on("data", keepLog);
    child.stdin!.on("error", () => {});

    this.ready = new Promise<Ready>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          reject(new Error("the Kokoro voice took too long to load"));
          this.stop();
        },
        opts.allowDownload ? INSTALL_LOAD_TIMEOUT_MS : LOAD_TIMEOUT_MS,
      );
      timer.unref();
      createInterface({ input: child.stdio[3] as NodeJS.ReadableStream }).on("line", (line) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        const req = typeof msg.id === "string" ? this.requests.get(msg.id) : undefined;
        switch (msg.type) {
          case "ready":
            clearTimeout(timer);
            this.info = { voice: String(msg.voice), voices: (msg.voices as string[]) ?? [], loadMs: Number(msg.loadMs) };
            debug(`kokoro: ready in ${this.info.loadMs} ms (voice ${this.info.voice})`);
            resolve(this.info);
            break;
          case "progress":
            this.onProgress?.(String(msg.message));
            break;
          case "audio":
            req?.onAudio(Number(msg.seq), Buffer.from(String(msg.pcm), "base64"));
            break;
          case "done":
            if (req && typeof msg.id === "string") {
              this.requests.delete(msg.id);
              req.resolve({ rssMb: Number(msg.rssMb), cancelled: msg.cancelled === true });
            }
            break;
          case "error":
            if (msg.fatal) {
              clearTimeout(timer);
              reject(new Error(String(msg.message)));
            } else if (req && typeof msg.id === "string") {
              this.requests.delete(msg.id);
              req.reject(new Error(String(msg.message)));
            }
            break;
        }
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        const why = new Error(`the Kokoro worker stopped (${signal ?? `exit ${code}`})${this.logTail ? `: ${tail(this.logTail, 3)}` : ""}`);
        reject(why); // no-op once ready
        for (const r of this.requests.values()) r.reject(why);
        this.requests.clear();
        if (this.child === child) {
          this.child = null;
          this.ready = null;
          this.info = null;
        }
      });
    });
    this.ready.catch(() => {}); // callers handle it; don't crash on an unobserved rejection
    return this.ready;
  }

  /** Generate `chunks` in order; onAudio receives each chunk's 24 kHz PCM as soon as it's ready. */
  speak(chunks: string[], onAudio: Request["onAudio"], signal?: AbortSignal): Promise<{ rssMb: number; cancelled: boolean }> {
    const child = this.child;
    if (!child || !this.running) return Promise.reject(new Error("the Kokoro worker is not running"));
    const id = String(this.nextId++);
    this.touch();
    return new Promise((resolve, reject) => {
      // Cancel: stop waiting right away; the worker drops the rest at its next sentence.
      const onAbort = () => {
        child.stdin!.write(JSON.stringify({ type: "cancel", id }) + "\n");
        const req = this.requests.get(id);
        this.requests.delete(id);
        req?.resolve({ rssMb: 0, cancelled: true });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const done = () => {
        signal?.removeEventListener("abort", onAbort);
        this.touch();
      };
      if (signal?.aborted) return resolve({ rssMb: 0, cancelled: true });
      this.requests.set(id, {
        onAudio,
        resolve: (r) => {
          done();
          if (r.rssMb > RECYCLE_RSS_MB) {
            debug(`kokoro: worker uses ${r.rssMb} MB — restarting it next time`);
            this.stop();
          }
          resolve(r);
        },
        reject: (e) => {
          done();
          reject(e);
        },
      });
      child.stdin!.write(JSON.stringify({ type: "speak", id, chunks }) + "\n");
    });
  }

  private touch(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      debug("kokoro: idle — stopping the worker to free memory");
      this.stop();
    }, CONFIG.serverIdleMinutes * 60_000);
    this.idleTimer.unref();
  }

  stop(): void {
    clearTimeout(this.idleTimer);
    const child = this.child;
    this.child = null;
    this.ready = null;
    this.info = null;
    if (child && child.exitCode === null) {
      child.stdin?.end(); // the worker exits when its stdin closes
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 2000).unref();
    }
  }
}

const worker = new KokoroWorker();

export function stopKokoro(): void {
  worker.stop();
}

/** The voice actually in use, once the worker has loaded (for reports). */
export function kokoroVoiceLabel(): string {
  const voice = worker.info?.voice ?? CONFIG.kokoroVoice;
  return `Kokoro ${voice} (${CONFIG.kokoroDtype})`;
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

interface Player {
  write(pcm: Buffer): void;
  /** All audio written; resolves when it has finished playing. */
  finish(): Promise<void>;
  kill(): void;
}

/** SoX `play`, streaming raw PCM: gapless, and starts with the first sentence. */
function soxPlayer(bin: string): Player {
  const child = spawn(bin, ["-q", "-t", "raw", "-r", String(KOKORO_RATE), "-e", "signed-integer", "-b", "16", "-c", "1", "-"], {
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr = (stderr + d).slice(-2000)));
  child.stdin!.on("error", () => {});
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  closed.catch(() => {});
  return {
    write: (pcm) => void child.stdin!.write(pcm),
    finish: async () => {
      child.stdin!.end();
      const code = await closed;
      if (code !== 0) throw new Error(`play failed (exit ${code}): ${tail(stderr) || "no output"}`);
    },
    kill: () => {
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}

/** macOS without SoX: one short WAV per sentence through afplay, back to back. */
function afplayPlayer(): Player {
  let dir: Promise<string> | undefined;
  let queue = Promise.resolve();
  let current: ChildProcess | null = null;
  let killed = false;
  let n = 0;
  const playOne = async (pcm: Buffer) => {
    if (killed) return;
    dir ??= mkdtemp(path.join(os.tmpdir(), "voice-mcp-kokoro-"));
    const file = path.join(await dir, `${n++}.wav`);
    await writeFile(file, Buffer.concat([wavHeaderFor(pcm.length, KOKORO_RATE), pcm]));
    if (killed) return;
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/afplay", [file], { stdio: "ignore" });
      current = child;
      child.on("error", reject);
      child.on("close", (code) => (code === 0 || killed ? resolve() : reject(new Error(`afplay failed (exit ${code})`))));
    });
  };
  const cleanup = async () => {
    if (dir) await rm(await dir, { recursive: true, force: true }).catch(() => {});
  };
  return {
    write: (pcm) => {
      queue = queue.then(() => playOne(pcm));
    },
    finish: async () => {
      try {
        await queue;
      } finally {
        await cleanup();
      }
    },
    kill: () => {
      killed = true;
      current?.kill("SIGKILL");
      void queue.catch(() => {}).finally(cleanup);
    },
  };
}

function openPlayer(): Player {
  const play = which("play");
  if (play) return soxPlayer(play);
  if (IS_MAC && isExecutable("/usr/bin/afplay")) return afplayPlayer();
  throw new SetupError("The Kokoro voice needs SoX's `play` to play audio (`brew install sox`).");
}

// ---------------------------------------------------------------------------
// Speaking
// ---------------------------------------------------------------------------

export interface KokoroSpeech {
  /** From the call to the first sound (includes loading the model on the first turn). */
  firstAudioMs: number;
  /** The model had to be loaded for this turn. */
  coldStart: boolean;
}

const silence = (ms: number) => Buffer.alloc(Math.round((KOKORO_RATE * ms) / 1000) * 2);

/** Speak `text` with Kokoro. Throws KokoroError (with what's still unspoken) if Kokoro fails. */
export async function speakKokoro(text: string, signal?: AbortSignal): Promise<KokoroSpeech> {
  const chunks = prepareForKokoro(text);
  if (!chunks.length) return { firstAudioMs: 0, coldStart: false };
  if (!isKokoroInstalled()) throw new KokoroError("the Kokoro voice isn't installed — call voice_setup with kokoro=true", chunks);
  if (signal?.aborted) throw new CancelledError();

  const t0 = Date.now();
  const coldStart = !worker.running;
  let player: Player | null = null;
  let handed = 0; // chunks given to the player
  let firstAudioMs = 0;
  try {
    await worker.start();
    if (signal?.aborted) throw new CancelledError();
    player = openPlayer();
    const p = player;
    const onAbort = () => p.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const r = await worker.speak(
        chunks,
        (seq, pcm) => {
          if (seq === 0) firstAudioMs = Date.now() - t0;
          p.write(seq < chunks.length - 1 ? Buffer.concat([pcm, silence(GAP_MS)]) : pcm);
          handed = seq + 1;
        },
        signal,
      );
      if (r.cancelled || signal?.aborted) throw new CancelledError();
      await p.finish();
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    return { firstAudioMs, coldStart };
  } catch (e) {
    player?.kill();
    if (e instanceof CancelledError || signal?.aborted) throw new CancelledError();
    if (e instanceof SetupError) throw new KokoroError(e.message, chunks);
    throw new KokoroError(e instanceof Error ? e.message : String(e), chunks.slice(handed));
  }
}

/** Speak `text` with Kokoro into a 16 kHz mono 16-bit WAV (for doctor and the round-trip tests). */
export async function synthesizeKokoroToFile(text: string, outFile: string): Promise<KokoroSpeech> {
  const chunks = prepareForKokoro(text);
  if (!isKokoroInstalled()) throw new SetupError("the Kokoro voice isn't installed — call voice_setup with kokoro=true");
  const t0 = Date.now();
  const coldStart = !worker.running;
  await worker.start();
  const parts: Buffer[] = [];
  let firstAudioMs = 0;
  await worker.speak(chunks, (seq, pcm) => {
    if (seq === 0) firstAudioMs = Date.now() - t0;
    parts[seq] = seq < chunks.length - 1 ? Buffer.concat([pcm, silence(GAP_MS)]) : pcm;
  });
  const pcm16k = resamplePcm16(Buffer.concat(parts), KOKORO_RATE, 16_000);
  await writeFile(outFile, Buffer.concat([wavHeaderFor(pcm16k.length, 16_000), pcm16k]));
  return { firstAudioMs, coldStart };
}

// ---------------------------------------------------------------------------
// Installing (only from voice_setup with kokoro=true, after the user agreed)
// ---------------------------------------------------------------------------

/** npm from the same Node installation that runs this server, else from PATH. */
function findNpm(): string | null {
  const sibling = path.join(path.dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
  return isExecutable(sibling) ? sibling : which("npm");
}

/** Install kokoro-js and download the model. Returns a one-line summary. */
export async function installKokoro(onProgress?: (message: string) => void): Promise<string> {
  const f = kokoroFiles();
  await mkdir(f.dir, { recursive: true });

  if (!existsSync(f.pkg)) {
    const npm = findNpm();
    if (!npm) throw new SetupError("npm was not found, so kokoro-js can't be installed. Install Node.js from https://nodejs.org (it includes npm).");
    const pkgJson = path.join(f.dir, "package.json");
    // "wx": create it only if it isn't there yet, in one step (no check-then-write race).
    await writeFile(
      pkgJson,
      JSON.stringify({ name: "mac-voice-mcp-kokoro", private: true, type: "module", description: "The optional Kokoro voice for mac-voice-mcp." }, null, 2) + "\n",
      { flag: "wx" },
    ).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "EEXIST") throw e;
    });
    onProgress?.(`installing kokoro-js ${KOKORO_JS_VERSION} with npm`);
    log(`Running: npm install kokoro-js@${KOKORO_JS_VERSION} in ${f.dir}`);
    const r = await run(npm, ["install", "--no-audit", "--no-fund", "--loglevel=error", `kokoro-js@${KOKORO_JS_VERSION}`], {
      timeoutMs: 20 * 60_000,
      cwd: f.dir,
      // npm is a Node script: make sure it finds this Node, even from a GUI app's minimal PATH.
      env: { PATH: [path.dirname(process.execPath), process.env.PATH ?? ""].join(path.delimiter) },
    });
    if (r.code !== 0) throw new Error(`npm install kokoro-js failed (exit ${r.code}): ${tail(r.stderr, 4)}`);
  }
  await writeFile(f.entry, ENTRY_MJS); // always (re)written: tiny, and it repairs an edited or stale one

  // Load it once, downloading the model if it isn't there yet. This is also the install's self-test.
  const hadModel = isKokoroModelPresent();
  worker.stop();
  worker.onProgress = onProgress;
  try {
    const info = await worker.start({ allowDownload: true });
    worker.stop(); // the next turn starts it normally (downloads off)
    return (
      `Installed the Kokoro voice (${info.voice}${hadModel ? "" : `, downloaded the ~${KOKORO_SIZES_MB[CONFIG.kokoroDtype]} MB model`}). ` +
      "It's used from the next turn on."
    );
  } finally {
    worker.onProgress = undefined;
  }
}
