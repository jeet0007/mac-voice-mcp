/**
 * The flight recorder: an opt-in, on-device log of what the voice pipeline decided, and "flag that".
 * Spec: docs/specs/flight-recorder.md.
 *
 * Off by default (VOICE_MCP_FLIGHT_RECORDER=off|on|audio): every function here is a cheap no-op then.
 * Numbers and reasons only: a string field that isn't a short plain token is dropped, so a transcript
 * or spoken text can't end up in the log even by mistake. Audio (mode `audio`) lives in memory, the last
 * few seconds, and reaches the disk only when the user flags a moment. Nothing here touches the
 * network: this module imports nothing that could (a test checks it). Writes are best-effort.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cacheRoot, readJson, voiceModeDir } from "../hooks/voice-files.mjs";
import { CONFIG, PKG } from "./config.js";
import { FRAME_BYTES, wavHeader } from "./endpointer.js";

export type FlightMode = "off" | "on" | "audio";

const DAY_MS = 86_400_000;
/** One day's event file stops growing at this size. */
export const MAX_DAY_BYTES = 10 * 1024 * 1024;
const FLAG_WINDOW_MS = 60_000;
const MAX_NOTE_CHARS = 500;

const intEnv = (name: string, fallback: number, min: number, max: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && process.env[name]?.trim() ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
};

/** Read each time (not cached), so the CLI and the tests see the environment they were given. */
export function flightMode(env = process.env): FlightMode {
  const v = env.VOICE_MCP_FLIGHT_RECORDER?.trim().toLowerCase();
  return v === "audio" ? "audio" : v === "on" || v === "1" || v === "true" ? "on" : "off";
}
export const flightEnabled = (): boolean => flightMode() !== "off";
export const retentionDays = (): number => intEnv("VOICE_MCP_FLIGHT_DAYS", 7, 1, 30);
export const audioSeconds = (): number => intEnv("VOICE_MCP_FLIGHT_AUDIO_SECONDS", 30, 5, 60);

export const flightDir = (): string => path.join(cacheRoot(), "flight");
const flagsDir = (): string => path.join(flightDir(), "flags");
const dayName = (t: number): string => `events-${new Date(t).toISOString().slice(0, 10)}.jsonl`;

// --- Writing -----------------------------------------------------------------------------------

type Field = number | boolean | string | null | undefined;
export type FlightFields = Record<string, Field>;

/** A reason or name, never prose: short, no spaces. Anything else is dropped. */
const TOKEN = /^[A-Za-z0-9._:+-]{1,40}$/;

function clean(fields: FlightFields): Record<string, number | boolean | string | null> {
  const out: Record<string, number | boolean | string | null> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "number") out[k] = Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
    else if (typeof v === "boolean" || v === null) out[k] = v;
    else if (typeof v === "string" && TOKEN.test(v)) out[k] = v;
  }
  return out;
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

let turnCounter = 0;
/** Start a new voice turn: events that follow carry its number. */
export function flightTurn(): number {
  return ++turnCounter;
}

const sizes = new Map<string, number>();
const full = new Set<string>();

/** Add one event to today's file. Never throws. */
export function flightEvent(ev: string, fields: FlightFields = {}, turn: number | null = turnCounter || null): void {
  if (!flightEnabled()) return;
  try {
    const t = Date.now();
    const file = path.join(flightDir(), dayName(t));
    ensureDir(flightDir());
    let size = sizes.get(file);
    if (size === undefined) size = existsSync(file) ? statSync(file).size : 0;
    const full1 = size >= MAX_DAY_BYTES;
    if (full1 && full.has(file)) return;
    const body = full1 ? { t, ev: "recorder.full", pid: process.pid } : { t, ev, pid: process.pid, ...(turn ? { turn } : {}), ...clean(fields) };
    const line = JSON.stringify(body) + "\n";
    if (full1) full.add(file);
    appendFileSync(file, line, { mode: 0o600 });
    sizes.set(file, size + Buffer.byteLength(line));
  } catch {
    /* a recorder problem never breaks a turn */
  }
}

// --- The audio ring (mode audio) ----------------------------------------------------------------

let ring: Buffer[] = [];

/** One 30 ms mic frame (16 kHz mono s16le). Kept in memory only, the last VOICE_MCP_FLIGHT_AUDIO_SECONDS. */
export function flightAudio(frame: Buffer): void {
  if (flightMode() !== "audio") {
    if (ring.length) ring = [];
    return;
  }
  ring.push(frame);
  const max = Math.floor((audioSeconds() * 16000 * 2) / FRAME_BYTES);
  if (ring.length > max) ring.splice(0, ring.length - max);
}

// --- Retention, status, purge --------------------------------------------------------------------

/** Delete event and flag files older than the retention. Returns how many were removed. */
export function flightSweep(now = Date.now()): number {
  let removed = 0;
  try {
    const cutoff = now - retentionDays() * DAY_MS;
    for (const dir of [flightDir(), flagsDir()]) {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        const st = statSync(file);
        if (st.isFile() && st.mtimeMs < cutoff) {
          rmSync(file, { force: true });
          sizes.delete(file);
          full.delete(file);
          removed++;
        }
      }
    }
  } catch {
    /* best effort */
  }
  return removed;
}

let sweepTimer: NodeJS.Timeout | undefined;
/** On server start: sweep now and once a day. Does nothing when the recorder is off. */
export function startFlight(): void {
  if (!flightEnabled() || sweepTimer) return;
  flightSweep();
  sweepTimer = setInterval(() => flightSweep(), DAY_MS);
  sweepTimer.unref();
}

function walk(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  if (!existsSync(dir)) return { files, bytes };
  for (const name of readdirSync(dir)) {
    const st = statSync(path.join(dir, name));
    if (st.isDirectory()) {
      const sub = walk(path.join(dir, name));
      files += sub.files;
      bytes += sub.bytes;
    } else {
      files++;
      bytes += st.size;
    }
  }
  return { files, bytes };
}

export function flightStatus(): { mode: FlightMode; dir: string; exists: boolean; files: number; bytes: number; days: number } {
  const { files, bytes } = walk(flightDir());
  return { mode: flightMode(), dir: flightDir(), exists: existsSync(flightDir()), files, bytes, days: retentionDays() };
}

/** Delete the whole folder (and the audio held in memory). Returns the files removed. */
export function flightPurge(): number {
  const { files } = walk(flightDir());
  rmSync(flightDir(), { recursive: true, force: true });
  sizes.clear();
  full.clear();
  ring = [];
  return files;
}

// --- Flags ----------------------------------------------------------------------------------------

export interface FlightEvent {
  t: number;
  ev: string;
  [k: string]: unknown;
}

/** Events from the last `windowMs`, oldest first. */
export function recentEvents(now = Date.now(), windowMs = FLAG_WINDOW_MS): FlightEvent[] {
  const out: FlightEvent[] = [];
  for (const t of [now - DAY_MS, now]) {
    let text: string;
    try {
      text = readFileSync(path.join(flightDir(), dayName(t)), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      try {
        const e = JSON.parse(line) as FlightEvent;
        if (typeof e.t === "number" && e.t >= now - windowMs && e.t <= now) out.push(e);
      } catch {
        /* a half-written line */
      }
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** "last turn ended by max-duration after 30.0 s; last reply finished: no, stopped" */
export function flagSummary(events: FlightEvent[]): string {
  const last = (ev: string) => [...events].reverse().find((e) => e.ev === ev);
  const l = last("listen.end");
  const s = last("speak.end");
  const total = num(l?.totalMs);
  const turn = l ? `last turn ended by ${String(l.reason)}${total !== null ? ` after ${(total / 1000).toFixed(1)} s` : ""}` : "no turn in the last minute";
  const reply = s ? `last reply finished: ${s.finished ? "yes" : "no"}, ${String(s.reason)}` : "no reply in the last minute";
  return `${turn}; ${reply}`;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const stamp = (t: number): string => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-${pad(d.getUTCMilliseconds(), 3)}`;
};

export interface FlagResult {
  file: string;
  wav?: string;
  summary: string;
}

/**
 * Save the last minute: a markdown file with a one-line summary and the recent events, and, in `audio`
 * mode with `withAudio`, the audio ring as a 16 kHz mono WAV. Works while the recorder is on, or when an
 * earlier run left a folder behind (the CLI runs in its own process). Returns null if there's nothing to flag against.
 */
export function flightFlag(noteIn?: string, opts: { withAudio?: boolean } = {}): FlagResult | null {
  if (!flightEnabled() && !existsSync(flightDir())) return null;
  const now = Date.now();
  const note = (noteIn ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_CHARS);
  const id = stamp(now);
  const events = recentEvents(now);
  const summary = flagSummary(events);
  ensureDir(flagsDir());
  const file = path.join(flagsDir(), `flag-${id}.md`);
  let wav: string | undefined;
  if (opts.withAudio && flightMode() === "audio" && ring.length) {
    const pcm = Buffer.concat(ring);
    wav = path.join(flagsDir(), `flag-${id}.wav`);
    writeFileSync(wav, Buffer.concat([wavHeader(pcm.length), pcm]), { mode: 0o600 });
  }
  const settings = {
    tts: CONFIG.tts,
    voice: CONFIG.voice ?? "auto",
    rate: CONFIG.rate ?? "default",
    kokoroVoice: CONFIG.kokoroVoice,
    language: CONFIG.language,
    model: CONFIG.modelName,
    endSilenceMs: CONFIG.endSilenceMs,
    startTimeoutSeconds: CONFIG.startTimeoutSeconds,
    speechMarginDb: CONFIG.speechMarginDb,
    minSpeechDb: CONFIG.minSpeechDb,
    recorder: CONFIG.recorder,
    callDuplex: CONFIG.callDuplex,
    flightRecorder: flightMode(),
  };
  const md = [
    `# Flag ${new Date(now).toISOString()}`,
    "",
    summary,
    "",
    `- Note: ${note || "(none)"}`,
    `- ${PKG.name} ${PKG.version} · ${process.platform} ${os.release()} · Node ${process.version}`,
    `- Audio: ${wav ? path.basename(wav) : "none"}`,
    "",
    "## Settings",
    "",
    "```json",
    JSON.stringify(settings, null, 2),
    "```",
    "",
    `## Events, last ${FLAG_WINDOW_MS / 1000} s (${events.length})`,
    "",
    "```jsonl",
    ...events.map((e) => JSON.stringify(e)),
    "```",
    "",
    "This file stays on this Mac. Share it only if you choose to.",
    "",
  ].join("\n");
  writeFileSync(file, md, { mode: 0o600 });
  flightEvent("flag", { id, hasNote: note.length > 0 });
  return { file, wav, summary };
}

/** `stop.seen`: the user's typing stopped speech or listening (reads the stop file the plugin writes). */
export function flightStopSeen(ownStartAt: number): void {
  if (!flightEnabled()) return;
  const stopAt = (readJson(path.join(voiceModeDir(cacheRoot()), "stop")) as { at?: unknown } | null)?.at;
  flightEvent("stop.seen", { stopAt: num(stopAt), ownStartAt });
}
