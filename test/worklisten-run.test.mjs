// The work listener transcribes what it hears from memory: no temp WAV with the warm server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(path.join(os.tmpdir(), "voice-mcp-wl-"));
const log = path.join(dir, "log.txt");
writeFileSync(log, "");
writeFileSync(path.join(dir, "stub-model.bin"), "x");
Object.assign(process.env, {
  // Its own temp folder: test files run in parallel, and another one's temp dirs must not show up in this listing.
  TMPDIR: mkdtempSync(path.join(dir, "tmp-")),
  STUB_LOG: log,
  STUB_SCENARIO: "answer",
  STUB_TRANSCRIPT: "Claude, use the other branch.",
  VOICE_MCP_RECORDER: "sox",
  VOICE_MCP_EXTRA_PATH: "",
  VOICE_MCP_WHISPER_SERVER: "1",
  VOICE_MCP_WHISPER_MODEL_PATH: path.join(dir, "stub-model.bin"),
  VOICE_MCP_CACHE_DIR: path.join(dir, "cache"),
  PATH: [path.join(ROOT, "test", "fixtures", "installable"), process.env.PATH].join(path.delimiter),
});
const { workListener, takeInbox, voiceModeDir } = await import("../dist/worklisten.js");
const { stopWhisperServer } = await import("../dist/stt.js");

const temps = () => readdirSync(os.tmpdir()).filter((n) => n.startsWith("voice-mcp-work-") || n.startsWith("voice-mcp-stt-")).sort();

test("what the work listener hears goes to the warm server from memory, with no temp WAV", async () => {
  mkdirSync(voiceModeDir(), { recursive: true });
  writeFileSync(path.join(voiceModeDir(), "listening.state"), JSON.stringify({ at: Date.now() }));
  const before = temps();
  try {
    workListener.start();
    const deadline = Date.now() + 15_000;
    while (!/whisper-server inference/.test(readFileSync(log, "utf8")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.match(readFileSync(log, "utf8"), /whisper-server inference bytes=/, "the server got the audio");
    assert.deepEqual(temps(), before, "no temp WAV (or temp directory) was written");
    assert.ok(!/whisper-cli/.test(readFileSync(log, "utf8")));
    const waitFor = Date.now() + 3000;
    let entries = takeInbox();
    while (!entries.length && Date.now() < waitFor) {
      await new Promise((r) => setTimeout(r, 50));
      entries = takeInbox();
    }
    assert.deepEqual(entries.map((e) => e.text), ["use the other branch."]);
  } finally {
    await workListener.stop();
    stopWhisperServer();
  }
});
