/**
 * Mic ownership. Internal to src/audio/: device.ts claims the mic for each session.
 *
 * Across processes, one voice turn at a time across every voice-mcp on this Mac — several Claude
 * Code windows, Claude Desktop and Cursor all share one speaker and one microphone. The lock is a
 * file created atomically (O_EXCL) holding the owner's pid and start time. A lock whose owner has
 * died (or that is implausibly old) is taken over, so a crash never blocks the mic for good. If the
 * lock can't be used at all (read-only or missing cache folder), turns go ahead without it rather
 * than failing.
 *
 * In this process, exclusive() runs one turn, call start or setup at a time, and a turn or a call
 * takes the mic from the work listener, waiting until its mic is really closed.
 */
import { closeSync, linkSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { CONFIG, debug } from "../config.js";
import { CancelledError, sleep } from "../proc.js";
import { isAlive, readJson } from "../state/voice-mode.js";
import type { Purpose } from "./device.js";

/** Longer than any real turn (speaking, up to two minutes of listening, transcribing). */
const STALE_AFTER_MS = 10 * 60_000;
/** A lock file that's still unreadable after this long was never going to be written. */
const UNREADABLE_GRACE_MS = 5_000;
const POLL_MS = 250;

interface Owner {
  pid: number;
  since: number;
  /** Held for a whole call (src/call/session.ts): as long as the owner lives, however long that is. */
  call?: true;
}

export class MicBusyError extends Error {
  override name = "MicBusyError";
}

export const lockFile = () => path.join(CONFIG.cacheDir, "mic.lock");

export const ON_A_CALL_ELSEWHERE =
  "The user is on a call in another window (another Claude window, Claude Desktop or Cursor holds the speaker and " +
  "microphone for it). Tell the user on screen; voice here works again once that call ends.";

function readOwner(file: string): Owner | null {
  const o = readJson(file) as Owner | null;
  return o && Number.isInteger(o.pid) && Number.isFinite(o.since) ? o : null;
}

/** The lock file's identity (inode) if it's stale, otherwise null. */
function staleIdentity(file: string, now: number): number | null {
  let ino: number;
  let mtimeMs: number;
  try {
    ({ ino, mtimeMs } = statSync(file));
  } catch {
    return null; // gone already; the next attempt will create it
  }
  const owner = readOwner(file);
  const stale = owner ? !isAlive(owner.pid) || (!owner.call && now - owner.since > STALE_AFTER_MS) : now - mtimeMs > UNREADABLE_GRACE_MS;
  return stale ? ino : null;
}

/**
 * Remove a stale lock without ever removing a fresh one someone else just created: move it aside
 * atomically, check it's the same file we judged stale, and put it back if it isn't.
 */
function takeOver(file: string, ino: number): void {
  const aside = `${file}.${process.pid}.${Date.now()}.stale`;
  try {
    renameSync(file, aside);
  } catch {
    return; // another session got there first
  }
  try {
    if (statSync(aside).ino !== ino) {
      try {
        linkSync(aside, file); // it was a live lock after all: restore it (fails harmlessly if one exists)
      } catch {
        /* a newer lock is already in place */
      }
    }
  } finally {
    try {
      unlinkSync(aside);
    } catch {
      /* ignore */
    }
  }
}

/** Remove the file only if it's still ours. */
function releaseIfOurs(file: string, me: Owner): void {
  const now = readOwner(file);
  if (!now || now.pid !== me.pid || now.since !== me.since) return;
  try {
    unlinkSync(file);
  } catch {
    /* already gone */
  }
}

const UNUSABLE = new Set(["EACCES", "EPERM", "EROFS", "ENOENT", "ENOTDIR"]);
const noLock = () => {};

export interface AcquireOptions {
  signal?: AbortSignal;
  /** Called once, when we start waiting for another session. */
  onWait?: () => void;
  waitMs?: number;
  /** Hold the mic for a whole call: other sessions give up at once instead of waiting. */
  call?: true;
}

/** Wait for the mic, take it, and return the function that gives it back. */
export async function acquireMicLock(opts: AcquireOptions = {}): Promise<() => void> {
  const file = lockFile();
  const waitMs = opts.waitMs ?? CONFIG.lockWaitSeconds * 1000;
  const deadline = Date.now() + waitMs;
  let waiting = false;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch (e) {
    debug("mic lock unavailable, continuing without it:", (e as Error).message);
    return noLock;
  }

  for (;;) {
    if (opts.signal?.aborted) throw new CancelledError();
    const me: Owner = { pid: process.pid, since: Date.now(), ...(opts.call && { call: true }) };
    try {
      const fd = openSync(file, "wx");
      try {
        writeSync(fd, JSON.stringify(me));
      } finally {
        closeSync(fd);
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        process.off("exit", release);
        releaseIfOurs(file, me);
      };
      process.on("exit", release); // a normal shutdown mid-turn still frees the mic
      return release;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (UNUSABLE.has(code)) {
        debug("mic lock unavailable, continuing without it:", (e as Error).message);
        return noLock;
      }
      if (code !== "EEXIST") throw e;
    }

    const ino = staleIdentity(file, Date.now());
    if (ino !== null) {
      debug("taking over a stale mic lock");
      takeOver(file, ino);
      continue;
    }
    if (readOwner(file)?.call) throw new MicBusyError(ON_A_CALL_ELSEWHERE);
    if (!waiting) {
      waiting = true;
      opts.onWait?.();
    }
    if (Date.now() > deadline) {
      throw new MicBusyError(
        "Another voice session on this Mac (another Claude window, Claude Desktop or Cursor) has been using the " +
          `speaker and microphone for over ${Math.round(waitMs / 1000)} seconds. ` +
          "Tell the user on screen, and try again once its current turn is over.",
      );
    }
    await sleep(POLL_MS);
  }
}

/**
 * Take the lock without waiting. Held: its release function. Someone else's: null, because anything
 * we said now would be recorded and transcribed as that other session's user.
 */
export async function lockIfFree(): Promise<(() => void) | null> {
  try {
    return await acquireMicLock({ waitMs: 0 });
  } catch (err) {
    if (err instanceof MicBusyError) return null;
    throw err;
  }
}

/** Another process holds the lock (it is in a voice turn or a call). */
function lockHeldElsewhere(): boolean {
  const pid = readOwner(lockFile())?.pid;
  return pid !== undefined && pid !== process.pid && isAlive(pid);
}

/** How often the work listener checks whether another process wants the mic. */
const BACKGROUND_WATCH_MS = 250;

/** The work listener's claim in this process: a turn or a call takes the mic from it. */
let background: { ctl: AbortController; released: Promise<void> } | null = null;

export interface Claim {
  /** Aborts when the mic is taken from this claim (the work listener's only). */
  readonly preempted: AbortSignal;
  /** Free the mic. Call only once it's really closed. Idempotent. */
  release(): void;
}

export interface ClaimOptions {
  /** Cancels waiting for the lock. */
  signal?: AbortSignal;
  /** Called once, when we start waiting for another session. */
  onWait?: () => void;
}

/**
 * Take the mic for `purpose`. A turn or a call first takes it from this process's work listener,
 * then waits for the lock (a call's lock makes others give up at once). The work listener never
 * takes the lock, so it never holds up another window's turn: it gives up (MicBusyError) while
 * another process holds it, and is preempted as soon as one does. Doctor takes nothing.
 */
export async function claim(purpose: Purpose, opts: ClaimOptions = {}): Promise<Claim> {
  const never = new AbortController().signal;
  if (purpose === "doctor") return { preempted: never, release: () => {} };
  if (purpose === "worklisten") {
    if (lockHeldElsewhere()) throw new MicBusyError("Another voice session is using the microphone.");
    const ctl = new AbortController();
    const watch = setInterval(() => lockHeldElsewhere() && ctl.abort(), BACKGROUND_WATCH_MS);
    let released!: () => void;
    const me = { ctl, released: new Promise<void>((r) => (released = r)) };
    background = me;
    return {
      preempted: ctl.signal,
      release() {
        clearInterval(watch);
        if (background === me) background = null;
        released();
      },
    };
  }
  if (background) {
    background.ctl.abort();
    await background.released;
  }
  const release = await acquireMicLock({ signal: opts.signal, onWait: opts.onWait, ...(purpose === "call" && { call: true as const }) });
  return { preempted: never, release };
}

/** Serialize calls: there is one speaker and one microphone. */
let queue: Promise<unknown> = Promise.resolve();
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}
