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
 * Talking while Claude works: after a spoken answer the hook marks this session in listening.state,
 * and the MCP server keeps listening for "Claude, …" (src/worklisten.ts), leaving what it hears in
 * inbox/. After any tool call, or when Claude tries to stop, the hook hands those words to Claude.
 * Typing or the session ending removes the mark, which stops the listening.
 *
 * State is one small file per Claude Code session, and expires after 30 idle minutes.
 * VOICE_MCP_STAY_IN_VOICE=0 in Claude Code's environment (settings.json "env") turns it off.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
  "(Speaking in the background",
  "(The user started typing",
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

// --- Talking while Claude works (shared with src/worklisten.ts) ---------------------------------

const INBOX_MAX_AGE_MS = 15 * 60_000;
const listeningFile = (dir) => path.join(dir, "listening.state");
const inboxDir = (dir) => path.join(dir, "inbox");

function readListening(dir) {
  try {
    return JSON.parse(readFileSync(listeningFile(dir), "utf8"));
  } catch {
    return null;
  }
}

function clearListening(dir, session) {
  if (readListening(dir)?.session === session) rmSync(listeningFile(dir), { force: true });
}

/** Take what the user said while this session worked (oldest first), if this is the session listening. */
export function takeInterjections(dir, session, now = Date.now()) {
  if (readListening(dir)?.session !== session) return [];
  let names;
  try {
    names = readdirSync(inboxDir(dir)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const file = path.join(inboxDir(dir), name);
    try {
      const entry = JSON.parse(readFileSync(file, "utf8"));
      rmSync(file, { force: true });
      if (typeof entry.text === "string" && now - entry.at < INBOX_MAX_AGE_MS) out.push(entry.text);
    } catch {
      rmSync(file, { force: true });
    }
  }
  return out;
}

export function interjectionReason(texts) {
  const said = texts.map((t) => (t ? `"${t}"` : "(only your name: they want to talk)")).join(", then ");
  return (
    `While you were working, the user said by voice: ${said}. ` +
    "Take it into account now: adjust what you're doing if it changes the plan. " +
    "Briefly acknowledge it by voice at your next natural pause (speak_and_listen), not in a separate turn right away unless they asked a question."
  );
}

/**
 * Handle one hook event. Returns { exitCode: 0 } to carry on, or { exitCode: 2, stderr } to
 * send Claude back (Stop only).
 */
export function handle(input, { env = process.env, now = Date.now() } = {}) {
  const session = input?.session_id;
  if (!session) return { exitCode: 0 };
  const dir = stateDir(env);
  const stayInVoice = !/^(0|false|no|off)$/i.test(env.VOICE_MCP_STAY_IN_VOICE?.trim() ?? "");

  switch (input.hook_event_name) {
    case "PostToolUse": {
      if (!isSpeakTool(input.tool_name)) {
        // Any other tool: hand over what the user said meanwhile, if anything. Not to a subagent
        // (its tool calls fire this hook too, with agent_id set): the words are for the main Claude.
        if (input.agent_id) return { exitCode: 0 };
        const said = takeInterjections(dir, session, now);
        return said.length ? { exitCode: 2, stderr: interjectionReason(said) } : { exitCode: 0 };
      }
      if (heardUser(input.tool_input, input.tool_response)) {
        if (stayInVoice) writeState(dir, session, { on: true, at: now, nudged: false });
        mkdirSync(dir, { recursive: true });
        writeFileSync(listeningFile(dir), JSON.stringify({ session, at: now }));
      } else if (input.tool_input?.listen === false && input.tool_response?.isError !== true && readListening(dir)?.session === session) {
        // Only an announcement ("give me a few minutes") while listening: keep listening, so the
        // user can still say "Claude, …" while Claude works.
        clearState(dir, session);
        writeFileSync(listeningFile(dir), JSON.stringify({ session, at: now }));
      } else {
        clearState(dir, session);
        clearListening(dir, session);
      }
      return { exitCode: 0 };
    }
    case "PostToolUseFailure":
      if (isSpeakTool(input.tool_name)) {
        clearState(dir, session);
        clearListening(dir, session);
      }
      return { exitCode: 0 };
    case "UserPromptSubmit":
    case "SessionEnd":
      clearState(dir, session);
      clearListening(dir, session);
      return { exitCode: 0 };
    case "Stop": {
      // Something said while Claude worked comes first, even after the one nudge per answer.
      const said = takeInterjections(dir, session, now);
      if (said.length) return { exitCode: 2, stderr: interjectionReason(said) };
      const s = stayInVoice ? readState(dir, session) : null;
      // Let it stop unless voice mode is on, fresh, and we haven't already sent it back since the last answer.
      if (!stayInVoice || input.stop_hook_active || !s?.on || now - s.at >= EXPIRE_MS || s.nudged) {
        // Claude is done working, so nothing said now could reach it: close the mic.
        clearListening(dir, session);
        return { exitCode: 0 };
      }
      writeState(dir, session, { ...s, nudged: true });
      return { exitCode: 2, stderr: STOP_REASON };
    }
    default:
      return { exitCode: 0 };
  }
}
