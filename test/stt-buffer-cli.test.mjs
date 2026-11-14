// transcribeBuffer without the warm server: the whisper-cli fallback still works, from a temp file that is removed after.
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
  VOICE_MCP_WHISPER_SERVER: "0",
  PATH: [path.join(ROOT, "test", "fixtures", "installable"), process.env.PATH].join(path.delimiter),
});
const { transcribeBuffer, stopWhisperServer } = await import("../dist/stt.js");
const { wavHeader } = await import("../dist/endpointer.js");

const sttTemp = () => readdirSync(os.tmpdir()).filter((n) => n.startsWith("voice-mcp-stt-")).sort();

test("the whisper-cli fallback transcribes a WAV buffer and cleans up its temp file", async () => {
  const pcm = Buffer.alloc(32000);
  const before = sttTemp();
  const text = await transcribeBuffer(Buffer.concat([wavHeader(pcm.length), pcm]), "stub-model.bin");
  assert.equal(text, "Stub transcript from the CLI.");
  assert.match(readFileSync(log, "utf8"), /whisper-cli wav=1\.00s/);
  assert.deepEqual(sttTemp(), before, "the temp WAV directory was removed");
  stopWhisperServer();
});
