import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chunkForSpeech, fixPronunciation, MAX_CHUNK_CHARS, prepareForKokoro } from "../dist/kokoro-text.js";
import { floatToPcm16, resamplePcm16 } from "../dist/pcm.js";
import { wavHeader as wavHeaderFor } from "../dist/endpointer.js";

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
    "I also updated the changelog. Then I bumped the version.",
    "Should I open the pull request now?",
  ]);
  // A very short opener ("Done.") is merged into the next sentence instead of being spoken alone.
  assert.deepEqual(chunkForSpeech("Done. All seventy tests pass."), ["Done. All seventy tests pass."]);
});

test("long sentences are split at clauses, and no chunk is too long for Kokoro", () => {
  const long = Array.from({ length: 12 }, (_, i) => `clause number ${i} has a few words in it`).join(", ") + ".";
  const chunks = chunkForSpeech(long);
  assert.equal(chunks.length, 12, "one clause each");
  assert.equal(chunks[0], "clause number 0 has a few words in it,");
  assert.equal(chunks.join(" "), long, "nothing is lost or reordered");
  const word = "x".repeat(400); // one unbreakable "word" still gets through, as its own chunk
  assert.deepEqual(chunkForSpeech(word), [word]);
});

test("the first chunk is a sentence or clause of at most 60 characters, else the first words", () => {
  assert.deepEqual(
    chunkForSpeech(
      "Okay. This is what I found: the test fails because the mock server starts after the first request, so the request times out before anything answers, and the retry never runs.",
    ),
    [
      "Okay. This is what I found:",
      "the test fails because the mock server starts after the first request,",
      "so the request times out before anything answers, and the retry never runs.",
    ],
    "the first clause, not a lone 'Okay.'",
  );
  // No clause in reach: cut between words, just before "with".
  assert.deepEqual(chunkForSpeech("Sure. The build broke because the lock file is out of date with the package file, so npm refuses."), [
    "Sure. The build broke because the lock file is out of date",
    "with the package file, so npm refuses.",
  ]);
});

// Issue #64: "...before the next sentence is" [pause] "ready".
const ISSUE_64 =
  'The voice code decides, not me. It splits my reply into sentences, and adds a short pause between them. The odd gap is most likely when a tiny first sentence like "Step six b" finishes before the next sentence is ready, so it waits in silence. Details on screen.';

test("a chunk ends at a sentence or clause, never at a bare space, when a clause boundary exists", () => {
  assert.deepEqual(chunkForSpeech(ISSUE_64), [
    "The voice code decides, not me.",
    "It splits my reply into sentences,",
    "and adds a short pause between them.",
    'The odd gap is most likely when a tiny first sentence like "Step six b" finishes before the next sentence is ready,',
    "so it waits in silence. Details on screen.",
  ]);
});

test("real replies: nothing lost, every later cut at punctuation, nothing over Kokoro's cap", () => {
  const replies = JSON.parse(readFileSync(new URL("./fixtures/replies.json", import.meta.url), "utf8"));
  assert.equal(replies.length, 35);
  const weight = (c) => c.length + (c.match(/[\p{N}\p{Lu}]/gu)?.length ?? 0);
  let firstCuts = 0;
  for (const reply of replies) {
    const chunks = prepareForKokoro(reply);
    assert.equal(chunks.join(" "), fixPronunciation(reply).replace(/\s+/g, " ").trim(), "nothing is lost or reordered");
    const atPunctuation = (c) => /[.!?…,;:—–]["')\]]*$/.test(c);
    if (chunks.length > 1 && !atPunctuation(chunks[0])) firstCuts++;
    for (const c of chunks.slice(1, -1)) assert.ok(atPunctuation(c), `cut mid-clause: "${c}"`);
    assert.ok(weight(chunks[0]) <= 60, `first chunk "${chunks[0]}"`);
    for (const c of chunks) assert.ok(weight(c) <= MAX_CHUNK_CHARS, `over the cap: "${c}"`);
  }
  assert.equal(firstCuts, 7, "only a first sentence with no clause in its first 60 characters is cut between words");
});

test("abbreviations, decimals, times and thousands are never split", () => {
  assert.deepEqual(chunkForSpeech("Dr. Smith and Mr. Jones said so, vs. the others. Then it ended."), [
    "Dr. Smith and Mr. Jones said so,",
    "vs. the others. Then it ended.",
  ]);
  assert.deepEqual(
    chunkForSpeech(
      "I checked the notes from Mr. Jones and the summary from Dr. Patel this morning. They agree on the plan, e.g. the file moves first, i.e. before the rename, etc. and the rest waits.",
    ),
    [
      "I checked the notes from Mr. Jones",
      "and the summary from Dr. Patel this morning. They agree on the plan,",
      "e.g. the file moves first, i.e. before the rename, etc. and the rest waits.",
    ],
  );
  assert.deepEqual(
    chunkForSpeech(
      "The run took 12.5 seconds at 12:30, which is 1,000 ms slower than yesterday and about 1,250 ms slower than the week before, so the cache is probably cold again.",
    ),
    [
      "The run took 12.5 seconds at 12:30,",
      "which is 1,000 ms slower than yesterday and about 1,250 ms slower than the week before,",
      "so the cache is probably cold again.",
    ],
  );
});

test("digits and capitals count double against the cap: Kokoro reads them out one by one", () => {
  const digits = Array.from({ length: 125 }, (_, i) => String(1000 + i)).join(" ");
  const acronyms = Array.from({ length: 125 }, () => "ABCD").join(" ");
  // 134 characters of which 108 are digits or capitals: 242 of the 250 allowed.
  assert.deepEqual(chunkForSpeech(digits).map((c) => c.length), [29, 54, 104, 134, 134, 134, 29]);
  assert.deepEqual(chunkForSpeech(acronyms).map((c) => c.length), [29, 54, 104, 134, 134, 134, 29]);
  assert.equal(chunkForSpeech(digits).join(" "), digits);
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
