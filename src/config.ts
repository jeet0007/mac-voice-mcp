/**
 * Configuration (all optional environment variables) and logging.
 * stdout belongs to the MCP protocol, so every log line goes to stderr.
 */
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
export const PKG = require("../package.json") as { name: string; version: string };

export const IS_MAC = process.platform === "darwin";
export const IS_WIN = process.platform === "win32";

/** listen_seconds is an upper bound — listening normally ends when the user stops talking. */
export const DEFAULT_LISTEN_SECONDS = 30;
export const MAX_LISTEN_SECONDS = 120;
export const MAX_SPEAK_CHARS = 4000;

export function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return !["0", "false", "no", "off"].includes(raw);
}

const modelName = (process.env.VOICE_MCP_WHISPER_MODEL ?? "base.en").trim();

/** Everything this server ever downloads or links lives here, shared by every version and every client. */
const CACHE_ROOT =
  process.env.VOICE_MCP_CACHE_DIR?.trim() ||
  path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "mac-voice-mcp");

export const CONFIG = {
  // --- Speaking
  /** macOS voice name, e.g. "Samantha" (`say -v '?'` lists them). */
  voice: process.env.VOICE_MCP_VOICE?.trim() || undefined,
  /** Speech rate in words per minute (macOS `say -r`). */
  rate: process.env.VOICE_MCP_RATE?.trim() || undefined,
  /** Spoken text longer than this is cut at a sentence boundary (0 = no limit). */
  maxSpeakWords: Math.max(0, Math.floor(envNum("VOICE_MCP_MAX_SPEAK_WORDS", 120))),
  /** Play a short sound when the mic opens/closes (macOS). */
  chime: envBool("VOICE_MCP_CHIME", true),

  // --- Listening (turn-taking)
  /** End of turn: stop listening after this much silence once the user has spoken. */
  endSilenceMs: Math.max(300, envNum("VOICE_MCP_END_SILENCE_MS", 1200)),
  /** Give up if the user hasn't started talking within this many seconds. */
  startTimeoutSeconds: Math.max(1, envNum("VOICE_MCP_START_TIMEOUT_SECONDS", 8)),
  /** Speech must be this many dB above the room's background noise. Lower = more sensitive. */
  speechMarginDb: envNum("VOICE_MCP_SPEECH_MARGIN_DB", 12),
  /** …and never quieter than this absolute level (dBFS). */
  minSpeechDb: envNum("VOICE_MCP_MIN_SPEECH_DB", -48),
  /** Recorder: auto (SoX, else ffmpeg) | sox | ffmpeg. */
  recorder: (process.env.VOICE_MCP_RECORDER?.trim().toLowerCase() || "auto") as "auto" | "sox" | "ffmpeg",
  /** ffmpeg avfoundation audio input (macOS fallback recorder). */
  ffmpegDevice: process.env.VOICE_MCP_FFMPEG_DEVICE?.trim() || ":0",

  // --- Speech-to-text
  /** whisper.cpp model name (tiny.en, base.en, small.en, large-v3-turbo-q5_0, ...). */
  modelName,
  /** Absolute path to an existing ggml model — skips lookup and download entirely. */
  modelPath: process.env.VOICE_MCP_WHISPER_MODEL_PATH?.trim() || undefined,
  modelsDir: process.env.VOICE_MCP_MODELS_DIR?.trim() || path.join(CACHE_ROOT, "models"),
  /** Extra folders to look in for an existing ggml model before downloading (":"-separated). */
  modelSearchPaths: (process.env.VOICE_MCP_MODEL_SEARCH_PATHS ?? "")
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean),
  modelBaseUrl: (
    process.env.VOICE_MCP_MODEL_BASE_URL?.trim() || "https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
  ).replace(/\/+$/, ""),
  /** Explicit path to whisper.cpp's `whisper-cli`. */
  whisperBin: process.env.VOICE_MCP_WHISPER_BIN?.trim() || undefined,
  /** Explicit path to whisper.cpp's `whisper-server`. */
  whisperServerBin: process.env.VOICE_MCP_WHISPER_SERVER_BIN?.trim() || undefined,
  /** Keep the model loaded in a local whisper-server between turns (much lower latency). */
  useWhisperServer: envBool("VOICE_MCP_WHISPER_SERVER", true),
  /** Stop the warm whisper-server after this many idle minutes to free memory. */
  serverIdleMinutes: Math.max(1, envNum("VOICE_MCP_SERVER_IDLE_MINUTES", 15)),
  /** Spoken language code ("en", "th", "de", ...) or "auto". Defaults to "en" for *.en models, else "auto". */
  language: process.env.VOICE_MCP_LANGUAGE?.trim() || (modelName.endsWith(".en") ? "en" : "auto"),
  /** Optional initial prompt to bias vocabulary (names, jargon). */
  prompt: process.env.VOICE_MCP_WHISPER_PROMPT?.trim() || undefined,
  threads: Math.max(1, Math.floor(envNum("VOICE_MCP_THREADS", Math.min(8, os.cpus().length || 4)))),

  debug: envBool("VOICE_MCP_DEBUG", false),
} as const;

export function log(...args: unknown[]): void {
  console.error("[voice-mcp]", ...args);
}

export function debug(...args: unknown[]): void {
  if (CONFIG.debug) log(...args);
}

// GUI apps on macOS (Claude Desktop, Cursor) launch MCP servers with a minimal
// PATH that misses Homebrew. Append the usual locations so `rec`, `ffmpeg`,
// `brew` and the whisper.cpp tools are found without extra config.
// VOICE_MCP_EXTRA_PATH overrides the list (":"-separated; empty = add nothing — the tests use this).
if (!IS_WIN) {
  const extra =
    process.env.VOICE_MCP_EXTRA_PATH !== undefined
      ? process.env.VOICE_MCP_EXTRA_PATH.split(path.delimiter).filter(Boolean)
      : ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", path.join(os.homedir(), ".local", "bin")];
  const parts = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const p of extra) if (!parts.includes(p)) parts.push(p);
  process.env.PATH = parts.join(path.delimiter);
}
