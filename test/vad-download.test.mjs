// The silence filter download that succeeds: setup puts it in the cache, reports it, and the warm server restarts with it.
// In-process because no test may fetch the real model, so the test sets the expected checksum to its own stub body's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(path.join(os.tmpdir(), "voice-mcp-vad-"));
const home = path.join(dir, "home");
const models = path.join(home, ".cache", "mac-voice-mcp", "models");
mkdirSync(models, { recursive: true });
const model = path.join(models, "ggml-tiny.en.bin");
const fake = Buffer.alloc(1_100_000);
fake.writeUInt32LE(0x67676d6c, 0);
writeFileSync(model, fake);
const log = path.join(dir, "log.txt");
writeFileSync(log, "");

const body = Buffer.alloc(885_098, 7);
const mirror = createServer((req, res) => res.end(req.url === "/ggml-silero-v5.1.2.bin" ? body : ""));
await new Promise((r) => mirror.listen(0, "127.0.0.1", r));

Object.assign(process.env, {
  HOME: home,
  STUB_LOG: log,
  PATH: [path.join(ROOT, "test", "fixtures", "bin"), path.join(ROOT, "test", "fixtures", "installable"), path.dirname(process.execPath)].join(path.delimiter),
  VOICE_MCP_WHISPER_MODEL: "tiny.en",
  VOICE_MCP_WHISPER_SERVER: "1",
  VOICE_MCP_RECORDER: "sox",
  VOICE_MCP_EXTRA_PATH: "",
  VOICE_MCP_MODEL_BASE_URL: `http://127.0.0.1:${mirror.address().port}`,
});
const { VAD_MODEL } = await import("../dist/model.js");
const { runSetupFlow } = await import("../dist/setup.js");
const { transcribeBuffer, stopWhisperServer } = await import("../dist/stt.js");
const { wavHeader } = await import("../dist/endpointer.js");

const serverStarts = () => readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("whisper-server start "));

test("setup downloads the silence filter with consent, and the warm server restarts with it", async () => {
  VAD_MODEL.sha256 = createHash("sha256").update(body).digest("hex");
  const pcm = Buffer.alloc(32000);
  const wav = Buffer.concat([wavHeader(pcm.length), pcm]);
  try {
    assert.equal(await transcribeBuffer(wav, model), "Stub transcript from the server.");
    assert.doesNotMatch(serverStarts()[0], /--vad/);

    const { report } = await runSetupFlow({ install: true });
    const vad = path.join(models, "ggml-silero-v5.1.2.bin");
    assert.equal(statSync(vad).size, 885_098);
    assert.match(report, /^✔ Silence filter: Silero VAD/m);

    assert.equal(await transcribeBuffer(wav, model), "Stub transcript from the server.");
    const starts = serverStarts();
    assert.equal(starts.length, 2, "the server restarted");
    assert.ok(starts[1].includes(` --vad -vm ${vad} -vp 400 `), starts[1]);
  } finally {
    stopWhisperServer();
    mirror.close();
  }
});
