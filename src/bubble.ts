/**
 * The floating call bubble (docs/specs/call-bubble.md): a small window that shows a call from any
 * app, built on this Mac from native/call-bubble.swift after the user agrees (src/native-build.ts).
 * A new version rebuilds once, at the next setup or call start. The server starts the bubble at
 * call start and stops it at call end; it also exits by itself once call.json is gone.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONFIG, log } from "./config.js";
import { buildNative, nativeBin, nativeState } from "./native-build.js";
import { isAlive, voiceModeDir } from "./state/voice-mode.js";

/** One bubble per Mac, whichever server started it. */
const pidFile = () => path.join(voiceModeDir(), "bubble.pid");

const read = (file: string) => {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
};

let child: ChildProcess | null = null;
/** A call is on: a rebuild that finishes now starts the bubble. */
let wanted = false;
/** A call is on and the bubble is (or will be) showing: it wants the mic's levels for its glow. */
export const bubbleWanted = () => wanted;

/** At call start: show the bubble if the user built it and didn't turn it off. Never fails the call. */
export function startBubble(): void {
  if (!CONFIG.callBubble) return;
  const state = nativeState("call-bubble");
  if (state === "absent") return;
  wanted = true;
  if (state === "built") return launch();
  buildNative("call-bubble").then(
    (msg) => {
      log(msg);
      if (wanted) launch();
    },
    (e: unknown) => log(`couldn't rebuild the call bubble: ${e instanceof Error ? e.message : String(e)}`),
  );
}

function launch(): void {
  const running = Number(read(pidFile()));
  if (child || (running > 0 && isAlive(running))) return;
  // stdin is a pipe: the live transcript goes to the bubble one JSON line at a time (see sendToBubble).
  const bubble = spawn(nativeBin("call-bubble"), [], { stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, VOICE_MCP_CACHE_DIR: CONFIG.cacheDir } });
  bubble.on("error", (e) => log(`couldn't start the call bubble: ${e.message}`));
  bubble.stdin?.on("error", () => {}); // a bubble that closed its stdin or died keeps nothing from working
  bubble.on("exit", () => {
    if (child !== bubble) return;
    child = null;
    if (read(pidFile()) === String(bubble.pid)) rmSync(pidFile(), { force: true });
  });
  if (!bubble.pid) return;
  child = bubble;
  writeFileSync(pidFile(), String(bubble.pid));
}

/** At call end and shutdown. Synchronous, so a shutdown that exits right after still stops it. */
export function stopBubble(): void {
  wanted = false;
  if (!child) return;
  sendToBubble({ type: "clear" });
  child.kill("SIGTERM");
  child = null;
  rmSync(pidFile(), { force: true });
}

/** Too much waiting to be read: the bubble stalled, so a partial is dropped rather than queued. */
const MAX_PENDING_BYTES = 16 * 1024;

/**
 * The bubble can show the live transcript: this server started it (another server's bubble has no pipe
 * from us), it's up, and the user didn't turn the transcript off.
 */
export function bubbleTakesText(): boolean {
  return CONFIG.liveTranscript && !!child?.stdin?.writable;
}

export type BubbleText = { type: "partial" | "final"; text: string } | { type: "clear" };

/** One JSON line to the bubble's stdin. Text is never logged. Returns false when nothing was written. */
export function sendToBubble(message: BubbleText): boolean {
  const stdin = child?.stdin;
  if (!CONFIG.liveTranscript || !stdin?.writable) return false;
  if (message.type === "partial" && stdin.writableLength > MAX_PENDING_BYTES) return false;
  try {
    stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  } catch {
    return false;
  }
}
