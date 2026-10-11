// synthesizeToFile (doctor and the round-trip test) with the stub voice: a voice that writes
// almost no audio is retried once, then reported plainly instead of handing silence to whisper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(path.join(os.tmpdir(), "voice-mcp-synth-"));
const log = path.join(dir, "log.txt");
writeFileSync(log, "");
Object.assign(process.env, {
  STUB_LOG: log,
  VOICE_MCP_TTS: "say",
  VOICE_MCP_EXTRA_PATH: "",
  PATH: [path.join(ROOT, "test", "fixtures", "bin"), path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
});
const { synthesizeToFile } = await import("../dist/audio.js");
const { wavSeconds } = await import("../dist/pcm.js");

test("wavSeconds reads the data chunk, whatever comes before it", () => {
  const pcm = Buffer.alloc(32000);
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10); fmt.writeUInt32LE(16000, 12);
  const extra = Buffer.concat([Buffer.from("FLLR"), Buffer.from([4, 0, 0, 0]), Buffer.alloc(4)]);
  const data = Buffer.concat([Buffer.from("data"), Buffer.from([0x00, 0x7d, 0, 0]), pcm]);
  const head = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]);
  assert.equal(wavSeconds(Buffer.concat([head, fmt, extra, data])), 1);
  assert.equal(wavSeconds(Buffer.from("not a wav")), 0);
});

test("a voice that writes almost no audio is retried once, then reported clearly", async () => {
  const wav = path.join(dir, "a.wav");
  process.env.STUB_TTS_SHORT = "once";
  await synthesizeToFile("The build passed and all tests are green.", wav);
  assert.ok(statSync(wav).size > 30000, "the retry produced real audio");

  process.env.STUB_TTS_SHORT = "1";
  await assert.rejects(
    synthesizeToFile("The build passed and all tests are green.", path.join(dir, "b.wav")),
    /wrote only 0\.\d\d s of audio .*VOICE_MCP_VOICE/,
  );
  delete process.env.STUB_TTS_SHORT;
});
