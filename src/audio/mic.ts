// Mic ownership: the cross-process mic lock and the work listener's hand-off in this process. See docs/specs/audio.md.
import { closeSync, linkSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { CONFIG, debug } from "../config.js";
import { CancelledError, sleep } from "../proc.js";
import { isAlive, readJson } from "../state/voice-mode.js";
import type { Purpose } from "./device.js";

const STALE_AFTER_MS = 10 * 60_000;
const UNREADABLE_GRACE_MS = 5_000;
const POLL_MS = 250;

interface Owner {
  pid: number;
  since: number;
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

function staleIdentity(file: string, now: number): number | null {
  let ino: number;
  let mtimeMs: number;
  try {
    ({ ino, mtimeMs } = statSync(file));
  } catch {
    return null;
  }
  const owner = readOwner(file);
  const stale = owner ? !isAlive(owner.pid) || (!owner.call && now - owner.since > STALE_AFTER_MS) : now - mtimeMs > UNREADABLE_GRACE_MS;
  return stale ? ino : null;
}

// Never removes a fresh lock someone else just created: move aside, check the inode, put back.
function takeOver(file: string, ino: number): void {
  const aside = `${file}.${process.pid}.${Date.now()}.stale`;
  try {
    renameSync(file, aside);
  } catch {
    return;
  }
  try {
    if (statSync(aside).ino !== ino) {
      try {
        linkSync(aside, file);
      } catch {
        /* a newer lock is in place */
      }
    }
  } finally {
    try {
      unlinkSync(aside);
    } catch {
      /* gone */
    }
  }
}

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
  onWait?: () => void;
  waitMs?: number;
  call?: true;
}

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

export async function lockIfFree(): Promise<(() => void) | null> {
  try {
    return await acquireMicLock({ waitMs: 0 });
  } catch (err) {
    if (err instanceof MicBusyError) return null;
    throw err;
  }
}

function lockHeldElsewhere(): boolean {
  const pid = readOwner(lockFile())?.pid;
  return pid !== undefined && pid !== process.pid && isAlive(pid);
}

const BACKGROUND_WATCH_MS = 250;

let background: { ctl: AbortController; released: Promise<void> } | null = null;

export interface Claim {
  readonly preempted: AbortSignal;
  // Call only once the mic is really closed.
  release(): void;
}

export interface ClaimOptions {
  signal?: AbortSignal;
  onWait?: () => void;
}

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

let queue: Promise<unknown> = Promise.resolve();
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}
