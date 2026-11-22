// The wire protocol between Node and the native audio worker, defined once. See docs/specs/audio.md.

export const PROTOCOL_VERSION = 1;
export const MIC_RATE = 16000;
// 30 ms at 16 kHz, 16-bit mono.
export const FRAME_BYTES = 960;

export const DUCK_LEVELS = ["default", "min", "mid", "max"] as const;
export type DuckLevel = (typeof DUCK_LEVELS)[number];

// native/audio-worker.swift mirrors every message type: change it too. test/audio-worker-contract.test.mjs checks them.
// Privacy: ids, enums and numbers only, no words or audio a log could keep (bar the PCM, a cue's path, error's fixed message).
export type Command =
  | { op: "play"; id: number; rate: number; gain?: number }
  | { op: "play"; id: number; file: string; gain?: number }
  | { op: "pcm"; id: number; b64: string }
  | { op: "end"; id: number }
  | { op: "gain"; id: number; value: number; rampMs?: number }
  | { op: "pause"; id: number }
  | { op: "resume"; id: number }
  | { op: "stop"; id: number }
  | { op: "aec"; on: boolean }
  | { op: "agc"; on: boolean }
  | { op: "duck-others"; level: DuckLevel };

export const OPS = ["play", "pcm", "end", "gain", "pause", "resume", "stop", "aec", "agc", "duck-others"] as const satisfies readonly Command["op"][];

// `unknown-id` is normal after `done`: a command can cross it on the way.
export const ACK_STATUSES = ["ok", "bad-command", "unknown-id", "busy", "failed"] as const;
export const DONE_REASONS = ["finished", "stopped"] as const;
export const ERROR_STAGES = ["permission", "start", "run"] as const;
export const ROUTES = ["input", "output"] as const;

export type WorkerEvent =
  | { ev: "ready"; v: number; rate: number; aec: boolean }
  // `seq` is -1 and `op` empty for a line the worker could not read.
  | { ev: "ack"; seq: number; op: string; status: (typeof ACK_STATUSES)[number]; playedMs?: number; code?: number }
  | { ev: "pos"; id: number; playedMs: number }
  // Exactly once per accepted `play`, also when the worker shuts down.
  | { ev: "done"; id: number; reason: (typeof DONE_REASONS)[number]; playedMs: number }
  | { ev: "error"; stage: (typeof ERROR_STAGES)[number]; code: number; message: string }
  | { ev: "mic-closed" }
  | { ev: "route-changed"; which: (typeof ROUTES)[number] }
  | { ev: "frames-dropped"; count: number };

export const EVENTS = ["ready", "ack", "pos", "done", "error", "mic-closed", "route-changed", "frames-dropped"] as const satisfies readonly WorkerEvent["ev"][];

export const serializeCommand = (command: Command, seq: number): string => `${JSON.stringify({ ...command, seq })}\n`;
export const serializeEvent = (event: WorkerEvent): string => `${JSON.stringify(event)}\n`;

type Fields = Record<string, unknown>;

function fields(line: string): Fields | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : null;
  } catch {
    return null;
  }
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const count = (v: unknown): v is number => num(v) && v >= 0;
const bool = (v: unknown): v is boolean => typeof v === "boolean";
const str = (v: unknown): v is string => typeof v === "string";
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => str(v) && (list as readonly string[]).includes(v);
const optional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v);

export function parseEvent(line: string): WorkerEvent | null {
  const e = fields(line);
  if (!e) return null;
  switch (e.ev) {
    case "ready":
      return num(e.v) && count(e.rate) && bool(e.aec) ? { ev: "ready", v: e.v, rate: e.rate, aec: e.aec } : null;
    case "ack":
      if (!num(e.seq) || !str(e.op) || !oneOf(ACK_STATUSES, e.status) || !optional(e.playedMs, count) || !optional(e.code, num)) return null;
      return { ev: "ack", seq: e.seq, op: e.op, status: e.status, ...(count(e.playedMs) && { playedMs: e.playedMs }), ...(num(e.code) && { code: e.code }) };
    case "pos":
      return num(e.id) && count(e.playedMs) ? { ev: "pos", id: e.id, playedMs: e.playedMs } : null;
    case "done":
      return num(e.id) && oneOf(DONE_REASONS, e.reason) && count(e.playedMs) ? { ev: "done", id: e.id, reason: e.reason, playedMs: e.playedMs } : null;
    case "error":
      return oneOf(ERROR_STAGES, e.stage) && num(e.code) && str(e.message) ? { ev: "error", stage: e.stage, code: e.code, message: e.message } : null;
    case "mic-closed":
      return { ev: "mic-closed" };
    case "route-changed":
      return oneOf(ROUTES, e.which) ? { ev: "route-changed", which: e.which } : null;
    case "frames-dropped":
      return count(e.count) ? { ev: "frames-dropped", count: e.count } : null;
    default:
      return null;
  }
}

export function parseCommand(line: string): (Command & { seq: number }) | null {
  const c = fields(line);
  if (!c || !num(c.seq)) return null;
  const seq = c.seq;
  switch (c.op) {
    case "play":
      if (!num(c.id) || !optional(c.gain, count)) return null;
      if (str(c.file)) return { op: "play", seq, id: c.id, file: c.file, ...(count(c.gain) && { gain: c.gain }) };
      return count(c.rate) ? { op: "play", seq, id: c.id, rate: c.rate, ...(count(c.gain) && { gain: c.gain }) } : null;
    case "pcm":
      return num(c.id) && str(c.b64) ? { op: "pcm", seq, id: c.id, b64: c.b64 } : null;
    case "gain":
      if (!num(c.id) || !count(c.value) || !optional(c.rampMs, count)) return null;
      return { op: "gain", seq, id: c.id, value: c.value, ...(count(c.rampMs) && { rampMs: c.rampMs }) };
    case "end":
    case "pause":
    case "resume":
    case "stop":
      return num(c.id) ? { op: c.op, seq, id: c.id } : null;
    case "aec":
    case "agc":
      return bool(c.on) ? { op: c.op, seq, on: c.on } : null;
    case "duck-others":
      return oneOf(DUCK_LEVELS, c.level) ? { op: "duck-others", seq, level: c.level } : null;
    default:
      return null;
  }
}
