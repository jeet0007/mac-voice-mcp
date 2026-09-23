import { test } from "node:test";
import assert from "node:assert/strict";
import { Endpointer, FRAME_MS, FRAME_SAMPLES, wavHeader } from "../dist/endpointer.js";

const OPTS = { maxMs: 30_000, startTimeoutMs: 8_000, endSilenceMs: 1_200, marginDb: 12, minSpeechDb: -48 };
let seed = 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;

let clock = 0; // running frame count, so "speech" has a syllable rhythm across frames

/** zero | noise (quiet room) | loudnoise (a fan, or a mic's auto-gain lifting the room) | speech */
function frame(kind) {
  const t = clock++ * (FRAME_MS / 1000);
  const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t); // speech rises and falls ~4×/s
  const buf = Buffer.alloc(FRAME_SAMPLES * 2);
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const v =
      kind === "zero" ? 0
      : kind === "noise" ? rand() * 40
      : kind === "loudnoise" ? rand() * 800
      : 8000 * syllable * Math.sin(i / 5) + rand() * 40;
    buf.writeInt16LE(Math.round(Math.max(-32768, Math.min(32767, v))), i * 2);
  }
  return buf;
}
const ms = (n) => Math.round(n / FRAME_MS);

/** Feed a script like [["noise", 1000], ["speech", 1500]] then noise forever; returns [reason, endpointer, framesFed]. */
function runScript(script, opts = OPTS) {
  const ep = new Endpointer(opts);
  let fed = 0;
  const feed = (kind) => {
    fed++;
    return ep.push(frame(kind));
  };
  for (const [kind, dur] of script) for (let i = 0; i < ms(dur); i++) { const r = feed(kind); if (r) return [r, ep, fed]; }
  const tailKind = { zero: "zero", loudnoise: "loudnoise" }[script.at(-1)?.[0]] ?? "noise";
  for (let i = 0; i < ms(opts.maxMs) + 10; i++) { const r = feed(tailKind); if (r) return [r, ep, fed]; }
  return [null, ep, fed];
}

test("ends the turn ~1.2 s after the user stops talking", () => {
  const [reason, ep, fed] = runScript([["noise", 1000], ["speech", 2000]]);
  assert.equal(reason, "end-of-turn");
  const endedAfterSpeechMs = (fed - ms(3000)) * FRAME_MS;
  assert.ok(endedAfterSpeechMs >= 1000 && endedAfterSpeechMs <= 1400, `ended ${endedAfterSpeechMs} ms after speech`); // the last syllable fades out
  assert.ok(ep.speechSeconds > 1.2 && ep.speechSeconds <= 2.05, `speech ${ep.speechSeconds}s`); // quiet dips between syllables are not "voiced"
});

test("a pause shorter than the end-silence does not end the turn", () => {
  const [reason, ep] = runScript([["noise", 1000], ["speech", 1500], ["noise", 800], ["speech", 1500]]);
  assert.equal(reason, "end-of-turn");
  assert.ok(ep.speechSeconds > 2, `speech ${ep.speechSeconds}s`); // both phrases counted, so the pause did not end the turn
});

test("a cough before the answer is ignored", () => {
  const [reason, ep] = runScript([["noise", 1000], ["speech", 150], ["noise", 2000], ["speech", 1500]]);
  assert.equal(reason, "end-of-turn");
  assert.ok(ep.speechStartFrame >= ms(3000) - 2, `started at frame ${ep.speechStartFrame}`);
});

test("silence → no-speech after the start timeout", () => {
  const [reason, , fed] = runScript([["noise", 100]]);
  assert.equal(reason, "no-speech");
  assert.ok(Math.abs(fed * FRAME_MS - 8000) <= FRAME_MS);
});

test("all-zero input is flagged as a blocked microphone", () => {
  const [reason, ep] = runScript([["zero", 100]]);
  assert.equal(reason, "no-speech");
  assert.equal(ep.anyNonZero, false);
});

test("talking past the limit → max-duration", () => {
  const [reason] = runScript([["noise", 500], ["speech", 60_000]], { ...OPTS, maxMs: 5000 });
  assert.equal(reason, "max-duration");
});

test("room gets louder after the user speaks (mic auto-gain) → turn still ends promptly", () => {
  const [reason, , fed] = runScript([["noise", 1000], ["speech", 2000], ["loudnoise", 100]]);
  assert.equal(reason, "end-of-turn");
  const endedAfterSpeechMs = (fed - ms(3000)) * FRAME_MS;
  assert.ok(endedAfterSpeechMs <= 3000, `ended ${endedAfterSpeechMs} ms after speech`);
});

test("steady loud background before speaking is not mistaken for speech", () => {
  const [reason, ep] = runScript([["loudnoise", 3000], ["speech", 1500], ["loudnoise", 100]]);
  assert.equal(reason, "end-of-turn");
  assert.ok(ep.speechStartFrame >= ms(3000) - 2, `started at frame ${ep.speechStartFrame}`);
});

test("steady loud background with no speech → no-speech", () => {
  const [reason] = runScript([["loudnoise", 100]]);
  assert.equal(reason, "no-speech");
});

test("diagnostics report the levels behind the decision", () => {
  const [, ep] = runScript([["noise", 1000], ["speech", 2000]]);
  const d = ep.diagnostics();
  assert.ok(d.floorDb < -50 && d.speechDb > -30, JSON.stringify(d));
});

test("trimRange keeps the utterance plus 300 ms padding", () => {
  const [, ep, fed] = runScript([["noise", 2000], ["speech", 1000]]);
  const [first, last] = ep.trimRange(fed);
  assert.ok(Math.abs(first - (ms(2000) - ms(300))) <= 1, `first=${first}`);
  assert.ok(Math.abs(last - (ms(3000) + ms(300))) <= 2, `last=${last}`);
});

test("wavHeader describes 16 kHz mono PCM", () => {
  const h = wavHeader(32000);
  assert.equal(h.toString("ascii", 0, 4), "RIFF");
  assert.equal(h.readUInt32LE(24), 16000);
  assert.equal(h.readUInt16LE(22), 1);
  assert.equal(h.readUInt32LE(40), 32000);
});
