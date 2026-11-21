// Every rule of a call, with no audio, no clock and no processes: events in, effects out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initial, nextWake, step } from "../dist/call/engine/step.js";
import { EFFECT_STRINGS, EVENT_STRINGS } from "../dist/call/engine/types.js";

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "call", "engine");
const IDLE_MS = 1_800_000;
const SPEAKERS = { interrupt: "none", thinkingTick: true, idleMs: IDLE_MS };
const HEADPHONES = { ...SPEAKERS, interrupt: "pause" };

/** Every state and effect any test here produced, for the privacy test at the end. */
const seen = [];

/** A call under `policy` from time 0, fed `events` in order: each event's effects, and the state after. */
function call(policy, events) {
  let state = initial(policy, 0);
  const effects = events.map((e) => {
    const [next, fx] = step(state, e);
    state = next;
    seen.push(next, ...fx);
    return fx;
  });
  return { state, effects };
}

const onset = (at) => ({ at, type: "speech.onset" });
const ended = (at, utterance, reason = "end-of-turn") => ({ at, type: "utterance.ended", utterance, reason });
const dropped = (at, reason = "blip") => ({ at, type: "speech.dropped", reason });
const transcribed = (at, utterance, heard = "words") => ({ at, type: "transcribed", utterance, heard });
const failed = (at, utterance) => ({ at, type: "transcribe.failed", utterance });
const say = (at, id) => ({ at, type: "say.requested", say: id });
const played = (at, id) => ({ at, type: "playback.ended", say: id });
const drained = (at) => ({ at, type: "inbox.drained" });
const tick = (at) => ({ at, type: "tick" });
const end = (at, reason = "requested") => ({ at, type: "end.requested", reason });

const start = (id) => ({ type: "speech.start", say: id });
const deliver = (utterance, more = {}) => ({ type: "deliver", utterance, interrupted: null, missed: 0, ...more });
const CUE = { type: "cue", sound: "thinking-tick" };

test("on speakers a say waits while the user talks, and starts however their utterance ends (mute cuts it)", () => {
  const endings = [ended(900, 7), ended(900, 7, "max-duration"), ended(900, 7, "cut"), dropped(900, "blip"), dropped(900, "no-speech")];
  for (const ending of endings) {
    const { effects, state } = call(SPEAKERS, [onset(100), say(200, 1), say(300, 2), tick(5000), ending]);
    assert.deepEqual(effects.slice(0, 4), [[], [], [], []], "held, with no time limit");
    assert.deepEqual(effects[4], [start(1)], JSON.stringify(ending));
    assert.equal(nextWake(state), IDLE_MS, "nothing to wake for but the idle limit");
  }
});

test("says play one after another; on speakers the next one waits if the user is talking by then", () => {
  const { effects } = call(SPEAKERS, [say(0, 1), say(10, 2), say(20, 3), played(1000, 1), onset(1500), played(2000, 2), played(2100, 2), ended(3000, 7)]);
  assert.deepEqual(effects, [[start(1)], [], [], [start(2)], [], [], [], [start(3)]]);
});

test("on speakers talking over a reply doesn't pause it", () => {
  const { effects } = call(SPEAKERS, [say(0, 1), onset(500), ended(1500, 7), transcribed(1900, 7)]);
  assert.deepEqual(effects, [[start(1)], [], [], [deliver(7)]]);
});

test("on headphones talking over a reply pauses it; real words stop it, drop the says queued behind it, and say where it was cut", () => {
  const { effects } = call(HEADPHONES, [say(1000, 1), say(1100, 2), say(1200, 3), onset(2111), ended(3000, 7), tick(4111), transcribed(4500, 7), say(4600, 4), played(4700, 1)]);
  assert.deepEqual(effects, [
    [start(1)],
    [],
    [],
    [{ type: "speech.pause", say: 1 }],
    [],
    [], // still paused while the words are transcribed, however long that takes
    [{ type: "speech.stop", say: 1 }, { type: "speech.drop", say: 2 }, { type: "speech.drop", say: 3 }, deliver(7, { interrupted: { say: 1, playedMs: 1111 } })],
    [],
    [start(4)], // asked for after the interruption, so it plays
  ]);
});

test("a filler or nothing said over a reply resumes it at once and isn't handed to Claude; the next cut counts only what played", () => {
  for (const heard of ["filler", "empty"]) {
    const { effects } = call(HEADPHONES, [say(0, 1), onset(1000), ended(1400, 7), transcribed(1800, 7, heard), onset(2800), ended(3500, 8), transcribed(3900, 8)]);
    assert.deepEqual(effects.slice(1, 4), [[{ type: "speech.pause", say: 1 }], [], [{ type: "speech.resume", say: 1 }]], heard);
    assert.deepEqual(effects[6], [{ type: "speech.stop", say: 1 }, deliver(8, { interrupted: { say: 1, playedMs: 2000 } })], "1000 ms, 800 paused, 1000 more");
  }
});

test("a filler doesn't resume the reply while the user is still talking; what they say next decides", () => {
  const { effects } = call(HEADPHONES, [say(0, 1), onset(1000), ended(1400, 7), onset(1600), transcribed(1800, 7, "filler"), ended(2500, 8), transcribed(2900, 8)]);
  assert.deepEqual(effects.slice(2, 6), [[], [], [], []]);
  assert.deepEqual(effects[6], [{ type: "speech.stop", say: 1 }, deliver(8, { interrupted: { say: 1, playedMs: 1000 } })]);
});

test("no words within 2 s of talking over a reply resumes it, but never while the user is still talking", () => {
  const cough = call(HEADPHONES, [say(0, 1), onset(1000), dropped(1300), tick(2000), tick(3000)]);
  assert.equal(nextWake(call(HEADPHONES, [say(0, 1), onset(1000), dropped(1300)]).state), 3000);
  assert.deepEqual(cough.effects.slice(2), [[], [], [{ type: "speech.resume", say: 1 }]]);

  const long = call(HEADPHONES, [say(0, 1), onset(1000), tick(3500), dropped(3600)]);
  assert.deepEqual(long.effects.slice(2), [[], [{ type: "speech.resume", say: 1 }]]);
});

test("speech to text failing on what was said over a reply resumes it after the 2 s, and the next words say one was missed", () => {
  const { effects, state } = call(HEADPHONES, [say(0, 1), onset(1000), ended(1400, 7), failed(1800, 7), tick(3000), ended(5000, 8), transcribed(5400, 8), failed(6000, 9), failed(6100, 10), transcribed(6200, 11), transcribed(6300, 12)]);
  assert.deepEqual(effects.slice(3, 5), [[], [{ type: "speech.resume", say: 1 }]]);
  assert.deepEqual(effects[6], [deliver(8, { missed: 1 })]);
  assert.deepEqual(effects.slice(9), [[deliver(11, { missed: 2 })], [deliver(12)]]);
  assert.equal(state.phase, "on");
});

test("a reply that starts while the user is already talking isn't paused by it; talking while nothing plays pauses nothing", () => {
  const { effects } = call(HEADPHONES, [onset(0), say(100, 1), ended(900, 7), transcribed(1300, 7, "filler"), transcribed(1400, 8, "empty")]);
  assert.deepEqual(effects, [[], [start(1)], [], [deliver(7)], []]);
});

test("once the user's words reach Claude a tick plays every 1.5 s for 10 s at most, until Claude speaks", () => {
  const thinking = [ended(0, 7), transcribed(400, 7), drained(500)];
  const times = [2000, 3500, 5000, 6500, 8000, 9500, 11_000, 12_500];
  const ticks = call(SPEAKERS, [...thinking, tick(1000), ...times.map(tick)]);
  assert.equal(nextWake(call(SPEAKERS, thinking).state), 2000);
  assert.deepEqual(ticks.effects.slice(2), [[], [], [CUE], [CUE], [CUE], [CUE], [CUE], [CUE], [], []]);

  const spoke = call(SPEAKERS, [...thinking, tick(2000), say(2500, 1), tick(3500), played(4000, 1), tick(5500)]);
  assert.deepEqual(spoke.effects.slice(3), [[CUE], [start(1)], [], [], []]);

  const withSay = call(SPEAKERS, [ended(0, 7), transcribed(400, 7), say(450, 1), drained(500), played(900, 1), tick(2400)]);
  assert.deepEqual(withSay.effects.slice(3), [[], [], []], "words taken with a say's result: Claude has already answered");

  const off = call({ ...SPEAKERS, thinkingTick: false }, [...thinking, tick(2000)]);
  assert.deepEqual(off.effects[3], []);
});

test("words that reach Claude while a say plays or waits start the ticks once the says have played", () => {
  const { effects, state } = call(SPEAKERS, [say(0, 1), say(10, 2), ended(100, 7), transcribed(400, 7), drained(500), tick(2000), played(3000, 1), tick(4500), played(5000, 2), tick(6000), tick(6500)]);
  assert.deepEqual(effects.slice(4), [[], [], [start(2)], [], [], [], [CUE]]);
  assert.equal(nextWake(state), 8000);

  const held = call(SPEAKERS, [ended(0, 7), onset(100), say(200, 1), transcribed(400, 7), drained(500), ended(900, 8), played(2000, 1), tick(3500)]);
  assert.deepEqual(held.effects.slice(5), [[start(1)], [], [CUE]]);
});

test("no tick while the user talks, and the 10 s still run out", () => {
  const { effects, state } = call(SPEAKERS, [ended(0, 7), transcribed(400, 7), drained(500), onset(1000), tick(2000), dropped(2600), tick(2600), onset(3000)]);
  assert.deepEqual(effects.slice(4), [[], [], [CUE], []]);
  assert.equal(nextWake(state), 10_500);
});

test("a hang-up ends the call: a paused reply is stopped, queued says dropped, and nothing after it does anything", () => {
  const { effects, state } = call(HEADPHONES, [say(0, 1), say(10, 2), onset(1000), ended(1500, 7), transcribed(1900, 7, "hang-up"), played(2000, 1), say(2100, 3), tick(IDLE_MS * 2)]);
  assert.deepEqual(effects.slice(4), [[{ type: "speech.stop", say: 1 }, { type: "speech.drop", say: 2 }, { type: "teardown", reason: "hang-up" }], [], [], []]);
  assert.equal(nextWake(state), null);
});

test("ending a call lets the reply that is playing finish, and drops the says that haven't started", () => {
  for (const reason of ["requested", "session-ended", "mic-lost"]) {
    const playing = call(HEADPHONES, [say(0, 1), say(10, 2), end(500, reason), end(600, reason)]);
    assert.deepEqual(playing.effects.slice(2), [[{ type: "speech.drop", say: 2 }, { type: "teardown", reason }], []]);
  }
  const held = call(SPEAKERS, [onset(0), say(100, 1), end(500)]);
  assert.deepEqual(held.effects[2], [{ type: "speech.drop", say: 1 }, { type: "teardown", reason: "requested" }]);
});

test("the call ends after the idle limit without a word either way; a reply ending or words from the user start it again", () => {
  const silent = call(SPEAKERS, [tick(IDLE_MS - 1), tick(IDLE_MS)]);
  assert.deepEqual(silent.effects, [[], [{ type: "teardown", reason: "idle" }]]);

  const active = call(SPEAKERS, [say(0, 1), played(60_000, 1), tick(IDLE_MS), ended(100_000, 7), transcribed(120_000, 7), tick(IDLE_MS + 60_000)]);
  assert.deepEqual(active.effects.slice(2), [[], [], [deliver(7)], []]);
  assert.equal(nextWake(active.state), IDLE_MS + 120_000);
  assert.deepEqual(step(active.state, tick(IDLE_MS + 120_000))[1], [{ type: "teardown", reason: "idle" }]);
});

test("a tick nobody asked for changes nothing, in any state", () => {
  const states = [
    call(SPEAKERS, []),
    call(SPEAKERS, [onset(0), say(100, 1)]),
    call(HEADPHONES, [say(0, 1), onset(500)]),
    call(HEADPHONES, [say(0, 1), onset(500), ended(900, 7)]),
    call(SPEAKERS, [ended(0, 7), transcribed(400, 7), drained(500)]),
    call(SPEAKERS, [end(0)]),
  ].map((c) => c.state);
  for (const state of states) {
    const [next, effects] = step(state, tick(600));
    assert.equal(next, state);
    assert.deepEqual(effects, []);
  }
});

test("no state or effect carries a string that isn't one of the engine's enums", () => {
  const enums = new Set(["on", "off", "quiet", "talking", "idle", "thinking", "held", "speaking", "pause", "none"]);
  for (const table of [EVENT_STRINGS, EFFECT_STRINGS]) {
    for (const [type, fields] of Object.entries(table)) [type, ...Object.values(fields).flat()].forEach((s) => enums.add(s));
  }
  const strings = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
  const found = new Set(seen.flatMap(strings));
  assert.ok(found.size >= 20, "the tests above went through the engine");
  assert.deepEqual([...found].filter((s) => !enums.has(s)), []);
  const effectTypes = new Set(seen.filter((v) => "type" in v).map((v) => v.type));
  assert.deepEqual([...effectTypes].sort(), Object.keys(EFFECT_STRINGS).sort(), "every effect was produced, and each is in the table");
});

test("the engine imports nothing outside its directory, and reads no clock, timer, file or process", () => {
  const files = readdirSync(ENGINE).filter((f) => f.endsWith(".ts"));
  assert.deepEqual(files.sort(), ["step.ts", "types.ts", "words.ts"]);
  for (const file of files) {
    const src = readFileSync(path.join(ENGINE, file), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const imports = [...code.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
    assert.deepEqual(imports.filter((s) => !/^\.\/[^/]+$/.test(s)), [], `${file} imports from outside the engine`);
    assert.deepEqual(code.match(/\b(?:Date|performance|setTimeout|setInterval|setImmediate|process|require|globalThis|fetch)\b/g), null, `${file} reaches outside`);
  }
});
