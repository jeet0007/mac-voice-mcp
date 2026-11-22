// The optional Kokoro voice: its worker process, warm-up and install. See docs/specs/speech-output.md.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { CONFIG, debug, envNum, log } from "./config.js";
import { isExecutable, run, SetupError, tail, which } from "./proc.js";

export const KOKORO_JS_VERSION = "1.2.1";
export const KOKORO_RATE = 24_000;
export const KOKORO_SIZES_MB = { fp32: 326, q8: 92 } as const;
const RECYCLE_RSS_MB = 1500;
const LOAD_TIMEOUT_MS = 120_000;
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

export function isKokoroInstalled(): boolean {
  const f = kokoroFiles();
  return existsSync(f.entry) && existsSync(f.pkg);
}

export function isKokoroModelPresent(): boolean {
  return existsSync(kokoroFiles().model);
}

export function kokoroEnabled(): boolean {
  if (CONFIG.tts === "say") return false;
  if (CONFIG.tts === "kokoro") return true;
  return isKokoroInstalled() && isKokoroModelPresent();
}

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

const stallMs = () => Math.max(0.05, envNum("VOICE_MCP_KOKORO_STALL_SECONDS", 30)) * 1000;

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

  speak(chunks: string[], onAudio: Request["onAudio"], signal?: AbortSignal): Promise<{ rssMb: number; cancelled: boolean }> {
    const child = this.child;
    if (!child || !this.running) return Promise.reject(new Error("the Kokoro worker is not running"));
    const id = String(this.nextId++);
    this.touch();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        child.stdin!.write(JSON.stringify({ type: "cancel", id }) + "\n");
        const req = this.requests.get(id);
        this.requests.delete(id);
        req?.resolve({ rssMb: 0, cancelled: true });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      let stall: NodeJS.Timeout | undefined;
      const watchStall = () => {
        clearTimeout(stall);
        stall = setTimeout(() => {
          const req = this.requests.get(id);
          if (!req) return;
          this.requests.delete(id);
          debug("kokoro: the worker stopped answering — resetting it");
          this.stop();
          req.reject(new Error(`the Kokoro worker stopped answering (nothing for ${Math.round(stallMs() / 1000)} s)`));
        }, stallMs());
        stall.unref();
      };
      const done = () => {
        clearTimeout(stall);
        signal?.removeEventListener("abort", onAbort);
        this.touch();
      };
      if (signal?.aborted) return resolve({ rssMb: 0, cancelled: true });
      watchStall();
      this.requests.set(id, {
        onAudio: (seq, pcm) => {
          watchStall();
          onAudio(seq, pcm);
        },
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

export const kokoroWorker = new KokoroWorker();

export function stopKokoro(): void {
  kokoroWorker.stop();
}

export function prewarmKokoro(): void {
  if (!kokoroEnabled() || !isKokoroInstalled() || !isKokoroModelPresent() || kokoroWorker.running) return;
  kokoroWorker.start().catch((e: unknown) => debug("kokoro: warm-up failed:", e instanceof Error ? e.message : e));
}

export function kokoroVoiceLabel(): string {
  const voice = kokoroWorker.info?.voice ?? CONFIG.kokoroVoice;
  return `Kokoro ${voice} (${CONFIG.kokoroDtype})`;
}

function findNpm(): string | null {
  const sibling = path.join(path.dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
  return isExecutable(sibling) ? sibling : which("npm");
}

export async function installKokoro(onProgress?: (message: string) => void): Promise<string> {
  const f = kokoroFiles();
  await mkdir(f.dir, { recursive: true });

  if (!existsSync(f.pkg)) {
    const npm = findNpm();
    if (!npm) throw new SetupError("npm was not found, so kokoro-js can't be installed. Install Node.js from https://nodejs.org (it includes npm).");
    const pkgJson = path.join(f.dir, "package.json");
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
      // npm is a Node script: it must find this Node, even from a GUI app's minimal PATH.
      env: { PATH: [path.dirname(process.execPath), process.env.PATH ?? ""].join(path.delimiter) },
    });
    if (r.code !== 0) throw new Error(`npm install kokoro-js failed (exit ${r.code}): ${tail(r.stderr, 4)}`);
  }
  await writeFile(f.entry, ENTRY_MJS);

  const hadModel = isKokoroModelPresent();
  kokoroWorker.stop();
  kokoroWorker.onProgress = onProgress;
  try {
    const info = await kokoroWorker.start({ allowDownload: true });
    kokoroWorker.stop(); // the next turn starts it with downloads off
    return (
      `Installed the Kokoro voice (${info.voice}${hadModel ? "" : `, downloaded the ~${KOKORO_SIZES_MB[CONFIG.kokoroDtype]} MB model`}). ` +
      "It's used from the next turn on."
    );
  } finally {
    kokoroWorker.onProgress = undefined;
  }
}
