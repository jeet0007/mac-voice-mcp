/**
 * The voice-mode state folder (<cache>/voice-mode/): every file the server reads or writes there,
 * shared with the plugin hook and Voice Buddy. The only TS module that imports
 * hooks/voice-files.mjs, which stays the single source of the shared names.
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as files from "../../hooks/voice-files.mjs";
import { CONFIG } from "../config.js";

export { cacheRoot, isAlive, readJson } from "../../hooks/voice-files.mjs";

/** Shared with the hook: both live in the voice-mode state folder (hooks/voice-files.mjs). */
export const voiceModeDir = () => files.voiceModeDir(CONFIG.cacheDir);
export const inboxDir = () => files.inboxDir(voiceModeDir());
/**
 * The user started typing (written by the voice-buddy mod at the first keystroke, as {"at": ms}):
 * the voice turn running now stops speaking and listening at once, and so does listening while
 * Claude works.
 */
export const stopFile = (root = CONFIG.cacheDir) => path.join(files.voiceModeDir(root), "stop");

/** Shared with the plugin hook and Voice Buddy: who is on a call, and which session it belongs to. */
export const callFile = () => files.callFile(voiceModeDir());
export const muteFile = () => files.muteFile(voiceModeDir());
export const permissionFile = () => files.permissionFile(voiceModeDir());
export const levelsFile = () => files.levelsFile(voiceModeDir());

/**
 * The Claude Code session this server belongs to, once the plugin hook has told us (it marks
 * listening.state / call.json with the session id). Unknown until then.
 */
let ownSession: string | null = null;
export const setOwnSession = (session: unknown): void => {
  if (typeof session === "string" && session) ownSession = session;
};

/**
 * Was a stop asked for at or after `since` (ms)? A stop carries the session that typed ({"at", "session"});
 * another session's stop is ignored once we know our own. A stop without a session id (an older
 * plugin), or before we know ours, counts as before.
 */
export function stopRequestedSince(since: number, mine: string | null = ownSession): boolean {
  const stop = files.readJson(stopFile()) as { at?: unknown; session?: unknown } | null;
  if (typeof stop?.at !== "number" || stop.at < since) return false;
  if (typeof stop.session !== "string" || !stop.session || !mine) return true;
  return stop.session === mine;
}

/**
 * Where the voice turn is (speaking, listening…), for Voice Buddy's band above Claude Code's prompt,
 * or a display of your own. VOICE_MCP_PHASE_FILE=0 turns it off. null when no turn is running. One
 * file for the whole Mac (there's one voice turn at a time). Best effort: a display that can't read
 * it just shows nothing.
 */
export function showPhase(phase: string | null): void {
  if (!CONFIG.phaseFile) return;
  const file = path.join(voiceModeDir(), "phase.json");
  try {
    if (phase === null) rmSync(file, { force: true });
    else {
      mkdirSync(voiceModeDir(), { recursive: true });
      writeFileSync(file, JSON.stringify({ phase, at: Date.now() }));
    }
  } catch {
    /* the band is optional */
  }
}

/** Longest message kept: a 30-second interjection is about 100 words, so this only cuts whisper running on. */
export const INBOX_MAX_CHARS = 1000;

export type InboxEntry = files.InboxEntry;

/** Leave something the user said for the hook (or the next voice turn) to hand to Claude. */
export function addToInbox(text: string, now = Date.now()): void {
  // What the user said is private: only their account can list or read it.
  mkdirSync(inboxDir(), { recursive: true, mode: 0o700 });
  chmodSync(inboxDir(), 0o700); // also when an older version created it
  const kept = text.length > INBOX_MAX_CHARS ? `${text.slice(0, INBOX_MAX_CHARS)}…` : text;
  // The name is ours (time + random), never from the text; the text is only ever read back as a JSON string.
  const file = path.join(inboxDir(), `${now}-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(file, JSON.stringify({ text: kept, at: now } satisfies InboxEntry), { mode: 0o600, flag: "wx" });
}

/** Take everything waiting in the inbox (oldest first), removing it. Stale entries are dropped. */
export const takeInbox = (now = Date.now()): InboxEntry[] => files.takeInbox(voiceModeDir(), now);

/** The hook's mark that this session is in voice mode (listening.state), or null. */
export function readListening(): { at: number; session?: unknown } | null {
  const mark = files.readJson(files.listeningFile(voiceModeDir())) as { at?: unknown; session?: unknown } | null;
  const at = mark?.at;
  return typeof at === "number" ? { at, session: mark?.session } : null;
}
