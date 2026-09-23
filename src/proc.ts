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
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    activeChildren.add(child);

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

export function tail(s: string, lines = 6): string {
  return s.trim().split("\n").slice(-lines).join("\n");
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
