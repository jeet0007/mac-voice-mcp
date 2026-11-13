// The live transcript's scheduling (src/live-transcript.ts): when a partial is asked for, and what is dropped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveTranscript, utteranceFrames } from "../dist/live-transcript.js";

/** A LiveTranscript whose requests the test answers by hand. */
function live({ enabled = true, everyMs = 700 } = {}) {
  const asked = [];
  const shown = [];
  const l = new LiveTranscript({
    everyMs,
    enabled: () => enabled,
    request: (wav, signal) => new Promise((resolve) => asked.push({ wav, signal, resolve })),
    emit: (t) => shown.push(t),
  });
  /** `ms` of audio in 30 ms frames, with this much speech so far and this much quiet at the end. */
  const frames = (ms, speech, quiet = 0) => {
    for (let i = 0; i < ms / 30; i++) l.frame(speech, quiet, () => Buffer.from("wav"));
  };
  return { l, asked, shown, frames, off: () => (enabled = false) };
}
const tick = () => new Promise((r) => setImmediate(r));

test("no request until half a second of speech; then one about every 700 ms of audio", async () => {
  const { asked, frames, shown } = live();
  frames(450, 0.45);
  assert.equal(asked.length, 0);
  frames(30, 0.5);
  assert.equal(asked.length, 1);
  asked[0].resolve("so I think");
  await tick();
  frames(660, 0.8);
  assert.equal(asked.length, 1, "not before 700 ms have passed");
  frames(60, 1.0);
  assert.equal(asked.length, 2);
  assert.deepEqual(shown, ["so I think"]);
});

test("never two requests at once, however long one takes", () => {
  const { asked, frames } = live();
  frames(3000, 2);
  assert.equal(asked.length, 1);
});

test("not while the last 300 ms were quiet (the utterance is probably ending)", () => {
  const { asked, frames } = live();
  frames(900, 1, 300);
  assert.equal(asked.length, 0);
  frames(30, 1, 270);
  assert.equal(asked.length, 1);
});

test("a reply that arrives after the utterance ended is dropped, and the request is cancelled", async () => {
  const { l, asked, shown, frames } = live();
  frames(600, 1);
  assert.equal(asked.length, 1);
  l.end();
  assert.equal(asked[0].signal.aborted, true);
  asked[0].resolve("late words");
  await tick();
  assert.deepEqual(shown, []);
  frames(600, 1);
  assert.equal(asked.length, 2, "the next utterance asks again at once");
});

test("the same words aren't shown twice and empty text shows nothing", async () => {
  const { asked, shown, frames } = live({ everyMs: 400 });
  for (const reply of ["hello there", "hello there", "  ", null, "hello there again"]) {
    frames(600, 2);
    asked.at(-1).resolve(reply);
    await tick();
  }
  assert.deepEqual(shown, ["hello there", "hello there again"]);
});

test("a failed request shows nothing and the next one goes out", async () => {
  const { asked, shown, frames } = live();
  frames(600, 1);
  asked[0].resolve(null);
  await tick();
  frames(720, 1);
  assert.equal(asked.length, 2);
  assert.deepEqual(shown, []);
});

test("switched off (no bubble, no warm server): nothing is requested", () => {
  const { asked, frames, off } = live();
  off();
  frames(5000, 3);
  assert.equal(asked.length, 0);
});

test("a request carries at most the last 30 s, and starts a little before the speech", () => {
  const frame = (i) => Buffer.from([i & 255]);
  const all = Array.from({ length: 2000 }, (_, i) => frame(i));
  assert.equal(utteranceFrames(all.slice(0, 100), 40).length, 70);
  assert.equal(utteranceFrames(all.slice(0, 100), 3).length, 100);
  const tail = utteranceFrames(all, 5);
  assert.equal(tail.length, 1000);
  assert.equal(tail[0], all[1000]);
});
