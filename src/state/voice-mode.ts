// The voice-mode state folder the server shares with the plugin hook and Voice Buddy. See docs/specs/voice-mode.md.
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as files from "../../hooks/voice-files.mjs";
import { CONFIG } from "../config.js";

export { cacheRoot, isAlive, readJson } from "../../hooks/voice-files.mjs";

export const voiceModeDir = () => files.voiceModeDir(CONFIG.cacheDir);
export const inboxDir = () => files.inboxDir(voiceModeDir());
export const stopFile = (root = CONFIG.cacheDir) => path.join(files.voiceModeDir(root), "stop");

export const callFile = () => files.callFile(voiceModeDir());
export const muteFile = () => files.muteFile(voiceModeDir());
export const permissionFile = () => files.permissionFile(voiceModeDir());
export const levelsFile = () => files.levelsFile(voiceModeDir());

let ownSession: string | null = null;
export const setOwnSession = (session: unknown): void => {
  if (typeof session === "string" && session) ownSession = session;
};

export function stopRequestedSince(since: number, mine: string | null = ownSession): boolean {
  const stop = files.readJson(stopFile()) as { at?: unknown; session?: unknown } | null;
  if (typeof stop?.at !== "number" || stop.at < since) return false;
  if (typeof stop.session !== "string" || !stop.session || !mine) return true;
  return stop.session === mine;
}

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
    // the band is optional
  }
}

export const INBOX_MAX_CHARS = 1000;

export type InboxEntry = files.InboxEntry;

export function addToInbox(text: string, now = Date.now()): void {
  // private: only the user's account can list or read what they said
  mkdirSync(inboxDir(), { recursive: true, mode: 0o700 });
  chmodSync(inboxDir(), 0o700); // also when an older version created it
  const kept = text.length > INBOX_MAX_CHARS ? `${text.slice(0, INBOX_MAX_CHARS)}…` : text;
  // the name never comes from the text
  const file = path.join(inboxDir(), `${now}-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(file, JSON.stringify({ text: kept, at: now } satisfies InboxEntry), { mode: 0o600, flag: "wx" });
}

export const takeInbox = (now = Date.now()): InboxEntry[] => files.takeInbox(voiceModeDir(), now);

export function readListening(): { at: number; session?: unknown } | null {
  const mark = files.readJson(files.listeningFile(voiceModeDir())) as { at?: unknown; session?: unknown } | null;
  const at = mark?.at;
  return typeof at === "number" ? { at, session: mark?.session } : null;
}
