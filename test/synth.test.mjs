// synthesizeToFile (doctor and the round-trip test) with the stub voice: a voice that writes
// almost no audio is retried once, then reported plainly instead of handing silence to whisper.
// And the Kokoro voice's PCM with the fake model: edges trimmed, pauses by ending, what's left on failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(path.join(os.tmpdir(), "voice-mcp-synth-"));
const log = path.join(dir, "log.txt");
writeFileSync(log, "");
const kokoro = path.join(dir, "kokoro");
mkdirSync(path.join(kokoro, "node_modules", "kokoro-js"), { recursive: true });
writeFileSync(path.join(kokoro, "node_modules", "kokoro-js", "package.json"), '{"name":"kokoro-js","version":"1.2.1"}\n');
writeFileSync(path.join(kokoro, "entry.mjs"), readFileSync(path.join(ROOT, "test", "fixtures", "kokoro", "entry.mjs")));
Object.assign(process.env, {
  STUB_LOG: log,
  VOICE_MCP_KOKORO_DIR: kokoro,
  VOICE_MCP_TTS: "say",
  VOICE_MCP_EXTRA_PATH: "",
  PATH: [path.join(ROOT, "test", "fixtures", "bin"), path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
});
const { kokoroSpeech, synthesizeToFile } = await import("../dist/speech/synthesize.js");
const { stopKokoro } = await import("../dist/kokoro.js");
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

const REPLY = "The first sentence is spoken by Kokoro. The second part ends at a comma, and the rest of it is long enough to be its own chunk here.";

/** The reply's PCM buffers from the fake model in `mode`, and what was left unspoken. */
async function kokoroBuffers(mode) {
  process.env.FAKE_KOKORO = mode;
  const speech = kokoroSpeech(REPLY, new AbortController().signal);
  const buffers = [];
  let error;
  try {
    for await (const b of (await speech.load()).chunks) buffers.push(b);
  } catch (e) {
    error = e;
  } finally {
    stopKokoro();
    delete process.env.FAKE_KOKORO;
  }
  return { buffers, error, unspoken: speech.unspoken() };
}

test("Kokoro's edge silence is trimmed to 30 ms before and 50 ms after, then a pause by how the chunk ends", async () => {
  const { buffers, error } = await kokoroBuffers("padded");
  assert.equal(error, undefined);
  const zeros = (b, from, step) => {
    let n = 0;
    for (let i = from; i >= 0 && i < b.length / 2 && b.readInt16LE(i * 2) === 0; i += step) n++;
    return n;
  };
  // In 24 kHz samples: 720 = 30 ms; 1200 = 50 ms, plus 350 ms (8400) after a sentence, 200 ms (4800) after a comma, none at the end.
  assert.deepEqual(
    buffers.map((b) => [zeros(b, 0, 1), zeros(b, b.length / 2 - 1, -1)]),
    [
      [720, 9600],
      [720, 6000],
      [720, 1200],
    ],
  );
});

test("if Kokoro fails mid-reply, unspoken() is exactly the text not yet handed to the player", async () => {
  const { buffers, error, unspoken } = await kokoroBuffers("broken-generate");
  assert.match(error.message, /fake generate failure/);
  assert.equal(buffers.length, 1);
  assert.equal(unspoken, "The second part ends at a comma, and the rest of it is long enough to be its own chunk here.");
});
