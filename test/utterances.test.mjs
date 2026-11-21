// The one frame loop (src/listen/utterances.ts): frames in, onset / ended / blip out. An `echo` frame
// (our reply on speakers, or the user's mute) ends what the user was saying instead of throwing it away.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.VOICE_MCP_CACHE_DIR = mkdtempSync(path.join(os.tmpdir(), "voice-utterances-"));
const { speech, toFrames, tailFrame, toPcm } = createRequire(import.meta.url)("./fixtures/scenarios.cjs");
const { Utterances, listenContinuously } = await import("../dist/listen/utterances.js");
const { Endpointer } = await import("../dist/endpointer.js");

const quiet = (sec) => Array.from({ length: Math.round(sec / 0.03) }, () => ({ pcm: toPcm(tailFrame("noise")), echo: false }));
const talk = (sec) => toFrames(speech(sec)).map((f) => ({ pcm: toPcm(f), echo: false }));
/** Frames the user can't be heard in: their samples are silence, as a muted or gated mic would give. */
const unheard = (sec) => Array.from({ length: Math.round(sec / 0.03) }, () => ({ pcm: Buffer.alloc(960), echo: true }));
const fresh = () => new Endpointer({ maxMs: 60_000, startTimeoutMs: 60_000, endSilenceMs: 1500, marginDb: 12, minSpeechDb: -55 });
const wavSeconds = (wav) => (wav.length - 44) / 32000;

/** Push `frames` through a fresh loop; the events it emitted, in order, and each push's ending. */
function run(frames) {
  const events = [];
  const cut = new Utterances(fresh, { onHeard: (h) => events.push(h) });
  for (const f of frames) if (cut.push(f)) cut.reset();
  return events;
}

test("speech gives an onset at 250 ms, then the utterance with its audio once the user stops", () => {
  const events = run([...quiet(1), ...talk(1.5), ...quiet(2)]);
  assert.deepEqual(events.map((e) => e.kind), ["onset", "ended"]);
  assert.equal(events[1].reason, "end-of-turn");
  const s = wavSeconds(events[1].wav);
  assert.ok(s > 1.5 && s < 2.4, `the utterance with a little padding, ${s} s`);
});

test("a mute mid-word ends the sentence there: it is kept, with no unheard audio in it", () => {
  const events = run([...quiet(1), ...talk(1), ...unheard(3)]);
  assert.deepEqual(events.map((e) => e.kind), ["onset", "ended"]);
  assert.equal(events[1].reason, "cut");
  const s = wavSeconds(events[1].wav);
  assert.ok(s > 0.9 && s < 1.5, `only what was heard, ${s} s`);
});

test("speech cut before its onset is a blip: nothing reaches speech to text", () => {
  const events = run([...quiet(1), ...talk(0.15), ...unheard(1)]);
  assert.deepEqual(events.map((e) => e.kind), ["blip"]);
});

test("unheard frames are never judged as speech, however loud", () => {
  const loudButUnheard = talk(2).map((f) => ({ ...f, echo: true }));
  assert.deepEqual(run([...quiet(1), ...loudButUnheard, ...quiet(2)]), []);
});

test("on a call, talking after a mute starts a new utterance: the user isn't left talking", async () => {
  const frames = [...quiet(1), ...talk(1), ...unheard(1), ...quiet(1), ...talk(1), ...quiet(2)];
  const session = {
    interrupt: "none",
    signal: new AbortController().signal,
    ended: Promise.resolve(),
    close: async () => {},
    frames: () => (async function* () { yield* frames; })(),
  };
  const events = [];
  await listenContinuously(session, { onHeard: (h) => events.push(h.kind === "ended" ? `ended ${h.reason}` : h.kind) });
  assert.deepEqual(events, ["onset", "ended cut", "onset", "ended end-of-turn"]);
});
