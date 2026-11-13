// transcribeBuffer: the warm whisper-server gets the audio from memory, no temp WAV is written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(path.join(os.tmpdir(), "voice-mcp-sttbuf-"));
const log = path.join(dir, "log.txt");
writeFileSync(log, "");
Object.assign(process.env, {
  STUB_LOG: log,
  VOICE_MCP_EXTRA_PATH: "",
  VOICE_MCP_WHISPER_SERVER: "1",
  PATH: [path.join(ROOT, "test", "fixtures", "installable"), process.env.PATH].join(path.delimiter),
});
const { transcribeBuffer, stopWhisperServer } = await import("../dist/stt.js");
const { wavHeader } = await import("../dist/endpointer.js");

const sttTemp = () => readdirSync(os.tmpdir()).filter((n) => n.startsWith("voice-mcp-stt-")).sort();

test("the warm server transcribes a WAV buffer with no temp file", async () => {
  const pcm = Buffer.alloc(32000);
  const before = sttTemp();
  try {
    const text = await transcribeBuffer(Buffer.concat([wavHeader(pcm.length), pcm]), "stub-model.bin");
    assert.equal(text, "Stub transcript from the server.");
    assert.deepEqual(sttTemp(), before, "no temp WAV directory was created");
    assert.ok(!/whisper-cli/.test(readFileSync(log, "utf8")), "the CLI was not used");
  } finally {
    stopWhisperServer();
  }
});
