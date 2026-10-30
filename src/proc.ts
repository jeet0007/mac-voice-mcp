/** Child-process helpers: PATH lookup, a promise-based runner, and error types. */
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import path from "node:path";
import { debug, IS_WIN } from "./config.js";

/** Something the user has to install or configure — the message says how. */
export class SetupError extends Error {
  override name = "SetupError";
}

export class CancelledError extends Error {
  override name = "CancelledError";
  constructor() {
    super("Cancelled by client");
  }
}

export function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const whichCache = new Map<string, string | null>();

/** Forget cached lookups — needed right after `brew install` adds new binaries. */
export function resetWhichCache(): void {
  whichCache.clear();
}

/** Resolve a binary on PATH (cached). Absolute paths are checked as-is. */
export function which(bin: string): string | null {
  if (whichCache.has(bin)) return whichCache.get(bin)!;
  let found: string | null = null;
  if (path.isAbsolute(bin)) {
    found = isExecutable(bin) ? bin : null;
  } else {
    const exts = IS_WIN ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").concat([""]) : [""];
    outer: for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!dir) continue;
      for (const ext of exts) {
        const candidate = path.join(dir, bin + ext);
        if (isExecutable(candidate)) {
          found = candidate;
          break outer;
        }
      }
    }
  }
  whichCache.set(bin, found);
  return found;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  killSignal?: NodeJS.Signals;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Called with the process once it's started. */
  onProcess?: (child: ChildProcess) => void;
}

/** Every child we start, so shutdown can stop them all. */
export const activeChildren = new Set<ChildProcess>();

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new CancelledError());
    debug("exec:", cmd, args.join(" "));

    const child = spawn(cmd, args, {
      stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    activeChildren.add(child);
    opts.onProcess?.(child);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr?.setEncoding("utf8").on("data", (d: string) => (stderr += d));

    const kill = () => {
      child.kill(opts.killSignal ?? "SIGTERM");
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 2000).unref();
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, opts.timeoutMs)
      : undefined;
    opts.signal?.addEventListener("abort", kill, { once: true });

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", kill);
      activeChildren.delete(child);
    };

    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      cleanup();
      if (opts.signal?.aborted) reject(new CancelledError());
      else resolve({ code, stdout, stderr, timedOut });
    });

    if (opts.input !== undefined && child.stdin) {
      child.stdin.on("error", () => {}); // ignore EPIPE if the process exits early
      child.stdin.end(opts.input);
    }
  });
}

/** A process started ahead of time, waiting for its input on stdin (see startWaiting). */
export interface Waiting {
  /** Still running and not yet given its input. */
  readonly ready: boolean;
  /** When it was started (Date.now()). */
  readonly startedAt: number;
  /** Give it its input and wait for it to finish, like run(). */
  send(input: string, opts?: { signal?: AbortSignal; timeoutMs?: number; onProcess?: (child: ChildProcess) => void }): Promise<RunResult>;
  kill(): void;
}

/**
 * Start a process that reads its input from stdin, but don't give it the input yet: it can load
 * what it needs (a voice) in the meantime, and starts working the moment send() is called.
 */
export function startWaiting(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): Waiting {
  debug("exec (waiting for input):", cmd, args.join(" "));
  const startedAt = Date.now();
  const child = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
  activeChildren.add(child);
  let stdout = "";
  let stderr = "";
  let sent = false;
  let closed = false;
  let failed: Error | null = null;
  child.stdout?.setEncoding("utf8").on("data", (d: string) => (stdout += d));
  child.stderr?.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  child.stdin?.on("error", () => {});
  const exit = new Promise<number | null>((resolve) => {
    child.on("error", (err) => {
      failed = err;
      closed = true;
      activeChildren.delete(child);
      resolve(null);
    });
    child.on("close", (code) => {
      closed = true;
      activeChildren.delete(child);
      resolve(code);
    });
  });
  const kill = () => {
    if (closed) return;
    child.kill("SIGTERM");
    setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 2000).unref();
  };
  return {
    get ready() {
      return !sent && !closed;
    },
    startedAt,
    kill,
    async send(input, o = {}) {
      if (sent || closed) throw new Error("this process was already used, or has stopped");
      if (o.signal?.aborted) {
        kill();
        throw new CancelledError();
      }
      sent = true;
      o.onProcess?.(child);
      let timedOut = false;
      const timer = o.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            kill();
          }, o.timeoutMs)
        : undefined;
      o.signal?.addEventListener("abort", kill, { once: true });
      child.stdin?.end(input);
      try {
        const code = await exit;
        if (failed) throw failed;
        if (o.signal?.aborted) throw new CancelledError();
        return { code, stdout, stderr, timedOut };
      } finally {
        if (timer) clearTimeout(timer);
        o.signal?.removeEventListener("abort", kill);
      }
    },
  };
}

export function tail(s: string, lines = 6): string {
  return s.trim().split("\n").slice(-lines).join("\n");
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
