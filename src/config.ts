// Configuration from the optional VOICE_MCP_* environment variables, and logging. See docs/configuration.md.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cacheRoot } from "../hooks/voice-files.mjs";

export const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name: string; version: string };

export const IS_MAC = process.platform === "darwin";
export const IS_WIN = process.platform === "win32";
// Darwin 24 is macOS 15, the oldest the native audio worker runs on (Swift's Synchronization atomics).
export const IS_MACOS_15 = IS_MAC && Number(os.release().split(".")[0]) >= 24;

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
const language = process.env.VOICE_MCP_LANGUAGE?.trim() || (modelName.endsWith(".en") ? "en" : "auto");

export const DEVELOPER_PROMPT = "npm, JSON, TypeScript, git, main, rebase, pull request, CI, macOS.";

function whisperPrompt(): string | undefined {
  const raw = process.env.VOICE_MCP_WHISPER_PROMPT?.trim();
  if (raw && ["none", "off", "0", "false"].includes(raw.toLowerCase())) return undefined;
  if (raw) return raw;
  return language === "en" ? DEVELOPER_PROMPT : undefined;
}

const CACHE_ROOT = cacheRoot();

export const CONFIG = {
  cacheDir: CACHE_ROOT,
  lockWaitSeconds: Math.max(1, envNum("VOICE_MCP_LOCK_WAIT_SECONDS", 120)),

  tts: (["say", "kokoro"].includes(process.env.VOICE_MCP_TTS?.trim().toLowerCase() ?? "")
    ? process.env.VOICE_MCP_TTS!.trim().toLowerCase()
    : "auto") as "auto" | "say" | "kokoro",
  kokoroVoice: process.env.VOICE_MCP_KOKORO_VOICE?.trim() || "af_heart",
  kokoroSpeed: Math.min(2, Math.max(0.5, envNum("VOICE_MCP_KOKORO_SPEED", 1))),
  kokoroDtype: (process.env.VOICE_MCP_KOKORO_DTYPE?.trim().toLowerCase() === "q8" ? "q8" : "fp32") as "fp32" | "q8",
  kokoroDir: process.env.VOICE_MCP_KOKORO_DIR?.trim() || path.join(CACHE_ROOT, "kokoro"),
  voice: process.env.VOICE_MCP_VOICE?.trim() || undefined,
  rate: process.env.VOICE_MCP_RATE?.trim() || undefined,
  maxSpeakWords: Math.max(0, Math.floor(envNum("VOICE_MCP_MAX_SPEAK_WORDS", 120))),
  listenWhileWorking: envBool("VOICE_MCP_LISTEN_WHILE_WORKING", true),
  phaseFile: envBool("VOICE_MCP_PHASE_FILE", true),
  voiceStandby: envBool("VOICE_MCP_VOICE_STANDBY", true),
  chime: envBool("VOICE_MCP_CHIME", true),
  spokenErrors: envBool("VOICE_MCP_SPOKEN_ERRORS", true),

  endSilenceMs: Math.max(300, envNum("VOICE_MCP_END_SILENCE_MS", 1500)),
  startTimeoutSeconds: Math.max(1, envNum("VOICE_MCP_START_TIMEOUT_SECONDS", 15)),
  speechMarginDb: envNum("VOICE_MCP_SPEECH_MARGIN_DB", 12),
  minSpeechDb: envNum("VOICE_MCP_MIN_SPEECH_DB", -48),
  recorder: (process.env.VOICE_MCP_RECORDER?.trim().toLowerCase() || "auto") as "auto" | "sox" | "ffmpeg",
  ffmpegDevice: process.env.VOICE_MCP_FFMPEG_DEVICE?.trim() || ":default",

  callDuplex: (["full", "half"].includes(process.env.VOICE_MCP_CALL_DUPLEX?.trim().toLowerCase() ?? "")
    ? process.env.VOICE_MCP_CALL_DUPLEX!.trim().toLowerCase()
    : "auto") as "auto" | "full" | "half",
  audio: (["process", "0", "off", "false"].includes(process.env.VOICE_MCP_AUDIO?.trim().toLowerCase() ?? "") ? "process" : "native") as "native" | "process",
  callThinkingSound: envBool("VOICE_MCP_CALL_THINKING_SOUND", false),
  callBubble: envBool("VOICE_MCP_CALL_BUBBLE", true),
  liveTranscript: envBool("VOICE_MCP_LIVE_TRANSCRIPT", true),
  liveTranscriptMs: Math.min(2000, Math.max(400, envNum("VOICE_MCP_LIVE_TRANSCRIPT_MS", 700))),

  modelName,
  modelPath: process.env.VOICE_MCP_WHISPER_MODEL_PATH?.trim() || undefined,
  modelsDir: process.env.VOICE_MCP_MODELS_DIR?.trim() || path.join(CACHE_ROOT, "models"),
  modelSearchPaths: (process.env.VOICE_MCP_MODEL_SEARCH_PATHS ?? "")
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean),
  modelBaseUrl: (
    process.env.VOICE_MCP_MODEL_BASE_URL?.trim() || "https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
  ).replace(/\/+$/, ""),
  whisperBin: process.env.VOICE_MCP_WHISPER_BIN?.trim() || undefined,
  whisperServerBin: process.env.VOICE_MCP_WHISPER_SERVER_BIN?.trim() || undefined,
  useWhisperServer: envBool("VOICE_MCP_WHISPER_SERVER", true),
  serverIdleMinutes: Math.max(1, envNum("VOICE_MCP_SERVER_IDLE_MINUTES", 15)),
  language,
  prompt: whisperPrompt(),
  threads: Math.max(1, Math.floor(envNum("VOICE_MCP_THREADS", Math.min(8, os.cpus().length || 4)))),

  debug: envBool("VOICE_MCP_DEBUG", false),
} as const;

// stdout carries the MCP protocol, so every log line goes to stderr.
export function log(...args: unknown[]): void {
  console.error("[voice-mcp]", ...args);
}

export function debug(...args: unknown[]): void {
  if (CONFIG.debug) log(...args);
}

// GUI apps (Claude Desktop, Cursor) start MCP servers with a PATH that misses Homebrew.
if (!IS_WIN) {
  const extra =
    process.env.VOICE_MCP_EXTRA_PATH !== undefined
      ? process.env.VOICE_MCP_EXTRA_PATH.split(path.delimiter).filter(Boolean)
      : ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", path.join(os.homedir(), ".local", "bin")];
  const parts = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const p of extra) if (!parts.includes(p)) parts.push(p);
  process.env.PATH = parts.join(path.delimiter);
}
