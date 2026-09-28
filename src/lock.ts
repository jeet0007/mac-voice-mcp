/**
 * One voice turn at a time across every voice-mcp on this Mac — several Claude Code windows,
 * Claude Desktop and Cursor all share one speaker and one microphone.
 *
 * The lock is a file created atomically (O_EXCL) holding the owner's pid and start time.
 * A lock whose owner has died (or that is implausibly old) is taken over, so a crash never
 * blocks the mic for good. If the lock can't be used at all (read-only or missing cache
 * folder), turns go ahead without it rather than failing.
 */
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { CONFIG, debug } from "./config.js";
import { CancelledError, sleep } from "./proc.js";

/** Longer than any real turn (speaking, up to two minutes of listening, transcribing). */
const STALE_AFTER_MS = 10 * 60_000;
/** A lock file that's still unreadable after this long was never going to be written. */
const UNREADABLE_GRACE_MS = 5_000;
const POLL_MS = 250;

interface Owner {
  pid: number;
  since: number;
}

export class MicBusyError extends Error {
  override name = "MicBusyError";
}

export const lockFile = () => path.join(CONFIG.cacheDir, "mic.lock");

function readOwner(file: string): Owner | null {
  try {
    const o = JSON.parse(readFileSync(file, "utf8")) as Owner;
    return Number.isInteger(o.pid) && Number.isFinite(o.since) ? o : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
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
  const stale = owner ? !isAlive(owner.pid) || now - owner.since > STALE_AFTER_MS : now - mtimeMs > UNREADABLE_GRACE_MS;
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
    const me: Owner = { pid: process.pid, since: Date.now() };
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
