/**
 * The files the MCP server (src/) and the plugin hook (hooks/voice-mode-lib.mjs) share, in one place.
 * Plain Node with no build, because an installed plugin has no dist/: the hook imports it as is,
 * and dist/ imports it as ../hooks/voice-files.mjs (shipped in the npm package beside dist/).
 * Voice Buddy (plugins/voice-buddy) and hooks/after-tool.sh can't import it; tests pin their copies.
 */
import { readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Everything voice-mcp keeps lives under this folder. */
export function cacheRoot(env = process.env) {
  return env.VOICE_MCP_CACHE_DIR?.trim() || path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "mac-voice-mcp");
}

export const voiceModeDir = (root) => path.join(root, "voice-mode");
/** Which session is listening while Claude works. In the voice-mode folder, like the rest. */
export const listeningFile = (dir) => path.join(dir, "listening.state");
export const inboxDir = (dir) => path.join(dir, "inbox");
/** Who is on a call, and which session it belongs to. */
export const callFile = (dir) => path.join(dir, "call.json");
/** Present while the user has muted the call (the floating bubble's mute button): the mic hears nothing. */
export const muteFile = (dir) => path.join(dir, "mute");
/** Written by the plugin hook when Claude Code shows a permission prompt on a call: the call says so out loud. */
export const permissionFile = (dir) => path.join(dir, "permission");

/** Inbox entries older than this are stale and never delivered. */
export const INBOX_MAX_AGE_MS = 15 * 60_000;

/** The file's JSON, or null when it's missing or unreadable. */
export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists, owned by someone else
  }
}

/** Take everything waiting in the inbox (oldest first), removing it. Stale entries are dropped. */
export function takeInbox(dir, now = Date.now()) {
  let names;
  try {
    names = readdirSync(inboxDir(dir)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const file = path.join(inboxDir(dir), name);
    // Claim it first: the server and every session's hook drain this inbox, and only one rename wins.
    const claimed = `${file}.${process.pid}.taken`;
    try {
      renameSync(file, claimed);
    } catch {
      continue;
    }
    const entry = readJson(claimed);
    if (typeof entry?.text === "string" && now - entry.at < INBOX_MAX_AGE_MS) out.push(entry);
    rmSync(claimed, { force: true });
  }
  return out;
}
