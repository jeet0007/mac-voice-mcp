// The audio port's output on the process backend: every Playback settles when its player dies,
// stop() works on a paused player, and a player dying mid-reply hands the rest to the built-in voice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(path.join(os.tmpdir(), "voice-mcp-playback-"));
const log = path.join(dir, "log.txt");
writeFileSync(log, "");
// A SoX `play` that dies (exit 3) as soon as the first audio arrives.
const bin = path.join(dir, "bin");
mkdirSync(bin);
writeFileSync(path.join(bin, "play"), `#!/bin/sh\nhead -c 1 > /dev/null\necho "play died" >> "$STUB_LOG"\nexit 3\n`);
chmodSync(path.join(bin, "play"), 0o755);
const kokoro = path.join(dir, "kokoro");
mkdirSync(path.join(kokoro, "node_modules", "kokoro-js"), { recursive: true });
writeFileSync(path.join(kokoro, "node_modules", "kokoro-js", "package.json"), '{"name":"kokoro-js","version":"1.2.1"}\n');
writeFileSync(path.join(kokoro, "entry.mjs"), readFileSync(path.join(ROOT, "test", "fixtures", "kokoro", "entry.mjs")));
const onnx = path.join(kokoro, "models", "onnx-community", "Kokoro-82M-v1.0-ONNX", "onnx");
mkdirSync(onnx, { recursive: true });
writeFileSync(path.join(onnx, "model.onnx"), "fake");
Object.assign(process.env, {
  STUB_LOG: log,
  VOICE_MCP_KOKORO_DIR: kokoro,
  VOICE_MCP_TTS: "kokoro",
  FAKE_KOKORO: "hang-generate", // the first sentence comes at once, the second never: the player dies in between
  VOICE_MCP_VOICE: "",
  VOICE_MCP_EXTRA_PATH: "",
  PATH: [bin, path.join(ROOT, "test", "fixtures", "bin"), path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
});
const { play } = await import("../dist/audio/device.js");
const { speak } = await import("../dist/speech/replies.js");
const { stopKokoro } = await import("../dist/kokoro.js");

const stat = (pid) => spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return fn();
};
/** The built-in voice (the `say` stub) taking 30 s to speak, and its pid. */
async function longVoice() {
  writeFileSync(log, "");
  process.env.STUB_SAY_MS = "30000";
  const playback = play({ kind: "voice", text: "A long reply." });
  assert.ok(await until(() => readFileSync(log, "utf8").includes("tts-input")), "the voice started");
  delete process.env.STUB_SAY_MS;
  return { playback, pid: Number(readFileSync(log, "utf8").match(/tts-start (\d+)/)[1]) };
}

test("stop() on a paused player stops it, and done settles as stopped", { skip: process.platform === "win32" }, async () => {
  const { playback, pid } = await longVoice();
  playback.duck(0.3);
  assert.ok(await until(() => stat(pid).startsWith("T")), "paused below full volume");
  playback.duck(0); // idempotent
  const before = playback.playedMs();
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(playback.playedMs() - before < 50, "no time counts as played while paused");
  const t0 = Date.now();
  playback.stop();
  playback.stop();
  assert.equal(await playback.done, "stopped");
  assert.ok(Date.now() - t0 < 1000, "stopped at once, not after the 2 s SIGKILL fallback");
  assert.equal(stat(pid), "", "the process is gone");
});

test("a player killed from outside settles its Playback with an error", async () => {
  const { playback, pid } = await longVoice();
  process.kill(pid, "SIGKILL");
  await assert.rejects(playback.done, /Text-to-speech failed \(exit null\)/);
});

test("a speech player dying mid-stream settles at once and stops reading the source", async () => {
  let pulled = 0;
  let closed = false;
  async function* forever() {
    try {
      for (;;) {
        pulled++;
        yield Buffer.alloc(4800);
        await new Promise((r) => setTimeout(r, 20));
      }
    } finally {
      closed = true;
    }
  }
  const playback = play({ kind: "speech", chunks: forever() });
  await assert.rejects(playback.done, /play failed \(exit 3\)/);
  assert.ok(await until(() => closed), "the source was closed");
  assert.ok(pulled < 50);
});

test("a speech source that throws stops the player, and done rejects with its error", async () => {
  async function* broken() {
    yield Buffer.alloc(4800);
    throw new Error("the voice broke");
  }
  await assert.rejects(play({ kind: "speech", chunks: broken() }).done, /the voice broke/);
});

test("the speech player dying mid-reply: the built-in voice says what Kokoro hadn't handed over", async () => {
  writeFileSync(log, "");
  try {
    const text = "The first sentence is spoken by Kokoro. The second one is not.";
    const spoken = await speak(text).done;
    assert.equal(spoken.engine, "built-in");
    assert.match(spoken.fallback, /play failed \(exit 3\)/);
    assert.deepEqual(readFileSync(log, "utf8").match(/^speak .*$/gm), ['speak "The second one is not."']);
  } finally {
    stopKokoro();
  }
});
