// Starts and stops the floating call bubble and pipes it the live transcript. See docs/specs/call-bubble.md.
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONFIG, log } from "./config.js";
import { buildNative, nativeBin, nativeState } from "./native-build.js";
import { isAlive, voiceModeDir } from "./state/voice-mode.js";

const pidFile = () => path.join(voiceModeDir(), "bubble.pid");

const read = (file: string) => {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
};

let child: ChildProcess | null = null;
let wanted = false;
export const bubbleWanted = () => wanted;

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
  const bubble = spawn(nativeBin("call-bubble"), [], { stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, VOICE_MCP_CACHE_DIR: CONFIG.cacheDir } });
  bubble.on("error", (e) => log(`couldn't start the call bubble: ${e.message}`));
  bubble.stdin?.on("error", () => {}); // a bubble that died must not crash the server
  bubble.on("exit", () => {
    if (child !== bubble) return;
    child = null;
    if (read(pidFile()) === String(bubble.pid)) rmSync(pidFile(), { force: true });
  });
  if (!bubble.pid) return;
  child = bubble;
  writeFileSync(pidFile(), String(bubble.pid));
}

// Synchronous, so a shutdown that exits right after still stops it.
export function stopBubble(): void {
  wanted = false;
  if (!child) return;
  sendToBubble({ type: "clear" });
  child.kill("SIGTERM");
  child = null;
  rmSync(pidFile(), { force: true });
}

const MAX_PENDING_BYTES = 16 * 1024;

export function bubbleTakesText(): boolean {
  return CONFIG.liveTranscript && !!child?.stdin?.writable;
}

export type BubbleText = { type: "partial" | "final"; text: string } | { type: "clear" };

// Never logs the text.
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
