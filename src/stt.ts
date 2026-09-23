/**
 * Speech-to-text with whisper.cpp.
 *
 * Fast path: a warm `whisper-server` on 127.0.0.1 keeps the model loaded between
 * turns, so each reply skips the model load (and Metal start-up on Apple Silicon).
 * It's started in the background while the question is being spoken, and stopped
 * after VOICE_MCP_SERVER_IDLE_MINUTES of inactivity to give the memory back.
 *
 * Fallback: `whisper-cli`, one process per transcription. Always correct, just slower.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { CONFIG, debug, IS_WIN, log } from "./config.js";
import { CancelledError, isExecutable, run, SetupError, sleep, tail, which } from "./proc.js";
import { cleanTranscript } from "./speech-text.js";

export const STT_MISSING =
  "whisper.cpp (speech-to-text) is not installed. Call the voice_setup tool to check and install what's missing " +
  "(or run `brew install whisper-cpp`, or set VOICE_MCP_WHISPER_BIN to an existing `whisper-cli`).";

/** Where people usually clone and build whisper.cpp themselves. */
function sourceBuildDirs(): string[] {
  const home = os.homedir();
  return ["", "src", "code", "Code", "dev", "Developer", "projects", "Projects", "workspace", "git", "repos", "GitHub", "Downloads"].flatMap(
    (d) => [path.join(home, d, "whisper.cpp", "build", "bin"), path.join(home, d, "whisper.cpp")],
  );
}

export function findWhisperCli(): string | null {
  if (CONFIG.whisperBin) return which(CONFIG.whisperBin);
  // Homebrew's whisper-cpp formula ships `whisper-cli` (older releases: `whisper-cpp`).
  for (const bin of ["whisper-cli", "whisper-cpp", "whisper-cpp-cli"]) {
    const found = which(bin);
    if (found) return found;
  }
  // A whisper.cpp you built yourself and never put on PATH. Old builds call the CLI `main`.
  for (const dir of sourceBuildDirs()) {
    for (const bin of ["whisper-cli", "main"]) {
      const candidate = path.join(dir, bin);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

export function findWhisperServer(): string | null {
  if (CONFIG.whisperServerBin) return which(CONFIG.whisperServerBin);
  const onPath = which("whisper-server");
  if (onPath) return onPath;
  const cli = findWhisperCli();
  if (!cli) return null;
  // Next to the CLI; old source builds call the server `server` (and the CLI `main`).
  const names = path.basename(cli) === "main" ? ["whisper-server", "server"] : ["whisper-server"];
  for (const name of names) {
    const sibling = path.join(path.dirname(cli), IS_WIN ? `${name}.exe` : name);
    if (isExecutable(sibling)) return sibling;
  }
  return null;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** fetch() with a timeout that also honours the caller's abort signal (Node 18 compatible). */
async function fetchWithin(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

class WarmWhisperServer {
  private child: ChildProcess | null = null;
  private ready: Promise<string> | null = null;
  private model: string | null = null;
  private idleTimer: NodeJS.Timeout | undefined;
  private stderrTail = "";
  private failures = 0;

  /** Too many start failures (e.g. an old whisper.cpp build) → stop trying for this session. */
  get disabled(): boolean {
    return this.failures >= 2;
  }

  get running(): boolean {
    return !!this.child && this.child.exitCode === null;
  }

  /** Start (or reuse) a server for `model`. Resolves with its base URL once the model is loaded. */
  warm(model: string): Promise<string> {
    if (this.ready && this.model === model && this.running) {
      this.touch();
      return this.ready;
    }
    this.stop();
    const bin = findWhisperServer();
    if (!bin) return Promise.reject(new Error("whisper-server is not installed"));
    this.model = model;
    const ready = this.start(bin, model);
    this.ready = ready;
    ready.then(
      () => {
        this.failures = 0;
      },
      (e: unknown) => {
        this.failures++;
        debug("whisper-server failed to start:", e instanceof Error ? e.message : e);
        if (this.ready === ready) this.stop();
      },
    );
    this.touch();
    return ready;
  }

  private async start(bin: string, model: string): Promise<string> {
    const port = await freePort();
    const args = ["-m", model, "--host", "127.0.0.1", "--port", String(port), "-t", String(CONFIG.threads), "-l", CONFIG.language, "-nt"];
    if (CONFIG.prompt) args.push("--prompt", CONFIG.prompt);
    debug("starting whisper-server:", bin, args.join(" "));

    // Orphan guard: the server runs under a tiny shell that waits on our stdin pipe
    // and kills the server when that pipe closes — i.e. whenever this process exits,
    // even if it's killed hard. `detached` gives it a process group we can stop as one.
    const child = IS_WIN
      ? spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true })
      : spawn(
          "/bin/sh",
          ["-c", '"$@" </dev/null & pid=$!; read -r _; kill $pid 2>/dev/null; wait $pid 2>/dev/null', "voice-mcp-whisper", bin, ...args],
          { stdio: ["pipe", "ignore", "pipe"], detached: true },
        );
    this.child = child;
    this.stderrTail = "";
    child.stdin?.on("error", () => {});
    child.stderr?.setEncoding("utf8").on("data", (d: string) => (this.stderrTail = (this.stderrTail + d).slice(-3000)));
    child.on("exit", () => {
      if (this.child === child) {
        this.child = null;
        this.ready = null;
      }
    });

    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 180_000; // large models can take a while to load
    while (Date.now() < deadline) {
      if (this.child !== child) throw new Error(`whisper-server exited during start-up: ${tail(this.stderrTail, 3)}`);
      try {
        const res = await fetchWithin(`${base}/health`, {}, 1000);
        // 503 = still loading. 404 = an older server without /health, but it's up.
        if (res.ok || res.status === 404) {
          debug("whisper-server ready at", base);
          return base;
        }
      } catch {
        /* not listening yet */
      }
      await sleep(100);
    }
    throw new Error("whisper-server did not become ready in time");
  }

  async transcribe(wavFile: string, signal?: AbortSignal): Promise<string> {
    if (!this.ready) throw new Error("whisper-server is not running");
    const base = await this.ready;
    const form = new FormData();
    form.append("file", new Blob([await readFile(wavFile)], { type: "audio/wav" }), "reply.wav");
    form.append("temperature", "0.0");
    form.append("temperature_inc", "0.2");
    form.append("response_format", "json");

    const res = await fetchWithin(`${base}/inference`, { method: "POST", body: form }, 120_000, signal);
    if (signal?.aborted) throw new CancelledError();
    if (!res.ok) throw new Error(`whisper-server HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { text?: string; error?: string };
    if (json.error) throw new Error(`whisper-server: ${json.error}`);
    this.touch();
    return cleanTranscript(json.text ?? "");
  }

  private touch(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      debug("whisper-server idle — stopping it to free memory");
      this.stop();
    }, CONFIG.serverIdleMinutes * 60_000);
    this.idleTimer.unref();
  }

  stop(): void {
    clearTimeout(this.idleTimer);
    const child = this.child;
    this.child = null;
    this.ready = null;
    if (!child) return;
    child.stdin?.end(); // wrapper kills the server on EOF
    try {
      if (!IS_WIN && child.pid) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

const warmServer = new WarmWhisperServer();

const serverUsable = () => CONFIG.useWhisperServer && !warmServer.disabled && !!findWhisperServer();

/** Start loading the model in the background (called while the question is being spoken). */
export function prewarm(model: string): void {
  if (serverUsable()) warmServer.warm(model).catch(() => {});
}

export function stopWhisperServer(): void {
  warmServer.stop();
}

/** Which engine the next transcription will use — for the setup report. */
export function describeStt(): string {
  const cli = findWhisperCli();
  const server = findWhisperServer();
  const parts = [cli ? `whisper-cli (${cli})` : "", server ? "fast mode via whisper-server" : ""].filter(Boolean);
  if (server && !CONFIG.useWhisperServer) parts[parts.length - 1] = "whisper-server disabled by VOICE_MCP_WHISPER_SERVER=0";
  return parts.join("; ");
}

async function transcribeCli(bin: string, wavFile: string, model: string, signal?: AbortSignal): Promise<string> {
  const args = ["-m", model, "-f", wavFile, "-l", CONFIG.language, "-t", String(CONFIG.threads), "-nt", "-np"];
  if (CONFIG.prompt) args.push("--prompt", CONFIG.prompt);
  const result = await run(bin, args, { signal, timeoutMs: 180_000 });
  if (result.code !== 0) {
    throw new Error(`whisper.cpp failed (exit ${result.code}): ${tail(result.stderr) || "no output"}`);
  }
  return cleanTranscript(result.stdout);
}

export async function transcribe(wavFile: string, model: string, signal?: AbortSignal): Promise<string> {
  const started = Date.now();
  if (serverUsable()) {
    try {
      await warmServer.warm(model);
      const text = await warmServer.transcribe(wavFile, signal);
      debug(`transcribed via whisper-server in ${Date.now() - started} ms`);
      return text;
    } catch (e) {
      if (signal?.aborted || e instanceof CancelledError) throw new CancelledError();
      log("whisper-server unavailable, using whisper-cli:", e instanceof Error ? e.message : e);
      warmServer.stop();
    }
  }
  const cli = findWhisperCli();
  if (!cli) throw new SetupError(STT_MISSING);
  const text = await transcribeCli(cli, wavFile, model, signal);
  debug(`transcribed via whisper-cli in ${Date.now() - started} ms`);
  return text;
}
