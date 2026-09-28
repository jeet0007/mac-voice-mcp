/**
 * The logic behind the Claude Code plugin hook that keeps a voice conversation in voice
 * (hooks/voice-mode.mjs runs it; the tests import it directly).
 *
 *   PostToolUse(speak_and_listen)   the user answered out loud → voice mode ON for this session.
 *                                   listen:false or no answer → OFF.
 *   PostToolUseFailure(same)        the call failed (not set up, mic blocked, busy…) → OFF.
 *   UserPromptSubmit                the user typed something → OFF (they're back at the keyboard).
 *   Stop                            voice mode ON → send Claude back to reply with speak_and_listen,
 *                                   at most once per spoken answer, so it can never loop.
 *   SessionEnd                      clean up.
 *
 * State is one small file per Claude Code session, and expires after 30 idle minutes.
 * VOICE_MCP_STAY_IN_VOICE=0 in Claude Code's environment (settings.json "env") turns it off.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const EXPIRE_MS = 30 * 60_000;

export const STOP_REASON =
  "You're in a voice conversation with the user, and they may be away from the screen. " +
  "Reply by calling speak_and_listen, not with a text-only message. " +
  "If the conversation is over (the user said stop, or you're done), say a short goodbye with " +
  "speak_and_listen and listen: false. That ends voice mode.";

/**
 * How speak_and_listen results begin when the user did NOT answer out loud (see src/voice.ts,
 * src/lock.ts and src/server.ts). Only the start of the result is checked, so a user who *says*
 * one of these phrases doesn't end voice mode.
 */
export const NOT_HEARD_PREFIXES = [
  "(No speech detected",
  "(Spoken.",
  "The microphone returned pure digital silence",
  "voice-mcp is not set up yet:",
  "voice-mcp error:",
  "Another voice session on this Mac (another Claude window",
];

export function stateDir(env = process.env) {
  const cache = env.VOICE_MCP_CACHE_DIR?.trim() || path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "mac-voice-mcp");
  return path.join(cache, "voice-mode");
}

const stateFile = (dir, sessionId) => path.join(dir, `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100)}.json`);

function readState(dir, sessionId) {
  try {
    return JSON.parse(readFileSync(stateFile(dir, sessionId), "utf8"));
  } catch {
    return null;
  }
}

function writeState(dir, sessionId, state) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(stateFile(dir, sessionId), JSON.stringify(state));
}

function clearState(dir, sessionId) {
  try {
    unlinkSync(stateFile(dir, sessionId));
  } catch {
    /* already off */
  }
}

/** The first text of an MCP tool result, whatever shape Claude Code hands it over in. */
function firstText(response) {
  if (typeof response === "string") return response;
  const content = Array.isArray(response) ? response : response?.content;
  if (Array.isArray(content)) return content.find((c) => typeof c?.text === "string")?.text ?? "";
  return typeof response?.text === "string" ? response.text : "";
}

/** Did this speak_and_listen call hear the user? */
export function heardUser(toolInput, toolResponse) {
  if (toolInput?.listen === false) return false;
  if (toolResponse?.isError === true) return false;
  const text = firstText(toolResponse).trimStart();
  return text !== "" && !NOT_HEARD_PREFIXES.some((p) => text.startsWith(p));
}

const isSpeakTool = (name) => /speak_and_listen$/.test(name ?? "");

/**
 * Handle one hook event. Returns { exitCode: 0 } to carry on, or { exitCode: 2, stderr } to
 * send Claude back (Stop only).
 */
export function handle(input, { env = process.env, now = Date.now() } = {}) {
  if (/^(0|false|no|off)$/i.test(env.VOICE_MCP_STAY_IN_VOICE?.trim() ?? "")) return { exitCode: 0 };
  const session = input?.session_id;
  if (!session) return { exitCode: 0 };
  const dir = stateDir(env);

  switch (input.hook_event_name) {
    case "PostToolUse":
      if (!isSpeakTool(input.tool_name)) return { exitCode: 0 };
      if (heardUser(input.tool_input, input.tool_response)) writeState(dir, session, { on: true, at: now, nudged: false });
      else clearState(dir, session);
      return { exitCode: 0 };
    case "PostToolUseFailure":
      if (isSpeakTool(input.tool_name)) clearState(dir, session);
      return { exitCode: 0 };
    case "UserPromptSubmit":
    case "SessionEnd":
      clearState(dir, session);
      return { exitCode: 0 };
    case "Stop": {
      const s = readState(dir, session);
      // Let it stop unless voice mode is on, fresh, and we haven't already sent it back since the last answer.
      if (input.stop_hook_active || !s?.on || now - s.at >= EXPIRE_MS || s.nudged) return { exitCode: 0 };
      writeState(dir, session, { ...s, nudged: true });
      return { exitCode: 2, stderr: STOP_REASON };
    }
    default:
      return { exitCode: 0 };
  }
}
