import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkForSpeech, FIRST_CHUNK_CHARS, fixPronunciation, MAX_CHUNK_CHARS, prepareForKokoro } from "../dist/kokoro-text.js";
import { floatToPcm16, resamplePcm16, wavHeaderFor } from "../dist/pcm.js";

test("developer words espeak gets wrong are rewritten", () => {
  assert.equal(fixPronunciation("Edit the JSON and YAML files"), "Edit the jay-son and yammel files");
  assert.equal(fixPronunciation("see index.ts and package.json"), "see index dot T S and package dot jay-son");
  assert.equal(fixPronunciation("bumped to v0.4.0"), "bumped to 0 point 4 point 0");
  assert.equal(fixPronunciation("It uses SQLite and 2 GB of RAM"), "It uses S Q lite and 2 GB of ram");
  assert.equal(fixPronunciation("Plain words stay as they are."), "Plain words stay as they are.");
});

test("newlines become sentence breaks: Kokoro would stop reading at a newline", () => {
  assert.deepEqual(chunkForSpeech("First line\nsecond line"), ["First line. second line"]);
  assert.deepEqual(chunkForSpeech("Changes:\nadded a voice"), ["Changes: added a voice"]);
  assert.deepEqual(chunkForSpeech("  \n "), []);
});

test("the first chunk is short so speech starts quickly; the rest are merged into larger chunks", () => {
  const chunks = chunkForSpeech(
    "The build passed and all tests are green. I also updated the changelog. Then I bumped the version. Should I open the pull request now?",
  );
  assert.deepEqual(chunks, [
    "The build passed and all tests are green.",
    "I also updated the changelog. Then I bumped the version. Should I open the pull request now?",
  ]);
  // A very short opener ("Done.") is merged into the next sentence instead of being spoken alone.
  assert.deepEqual(chunkForSpeech("Done. All seventy tests pass."), ["Done. All seventy tests pass."]);
});

test("long sentences are split at clauses, then words, and no chunk is too long for Kokoro", () => {
  const long = Array.from({ length: 12 }, (_, i) => `clause number ${i} has a few words in it`).join(", ") + ".";
  const chunks = chunkForSpeech(long);
  assert.ok(chunks.length > 2);
  assert.ok(chunks[0].length <= FIRST_CHUNK_CHARS, `first chunk is ${chunks[0].length} chars`);
  for (const c of chunks) assert.ok(c.length <= MAX_CHUNK_CHARS, `chunk is ${c.length} chars`);
  assert.equal(chunks.join(" "), long, "nothing is lost or reordered");
  const word = "x".repeat(400); // one unbreakable "word" still gets through, as its own chunk
  assert.deepEqual(chunkForSpeech(word), [word]);
});

test("prepareForKokoro fixes pronunciation and chunks", () => {
  assert.deepEqual(prepareForKokoro("Saved config.json.\nDone?"), ["Saved config dot jay-son. Done?"]);
});

test("PCM helpers: float to 16-bit with clipping, resampling, WAV header", () => {
  const pcm = floatToPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5]));
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((i) => pcm.readInt16LE(i * 2)), [0, 32767, -32768, 32767, -32768, 16384]);

  const second = Buffer.alloc(24000 * 2); // 1 s at 24 kHz
  for (let i = 0; i < 24000; i++) second.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 24000)), i * 2);
  const down = resamplePcm16(second, 24000, 16000);
  assert.equal(down.length, 16000 * 2, "1 s at 16 kHz");
  // Still a 440 Hz tone: sample 9 at 16 kHz is the same instant as sample 13.5 at 24 kHz.
  assert.ok(Math.abs(down.readInt16LE(9 * 2) - Math.round(8000 * Math.sin((2 * Math.PI * 440 * 13.5) / 24000))) < 60);
  assert.equal(resamplePcm16(second, 24000, 24000).length, second.length);

  const h = wavHeaderFor(32000, 16000);
  assert.equal(h.length, 44);
  assert.equal(h.toString("ascii", 0, 4), "RIFF");
  assert.equal(h.readUInt32LE(24), 16000);
  assert.equal(h.readUInt32LE(40), 32000);
});
