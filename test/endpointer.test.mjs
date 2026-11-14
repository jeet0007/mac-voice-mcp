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

test("our own chime is ignored: a loud sound while ignoring neither starts nor ends a turn, and time still counts", () => {
  const ep = new Endpointer(OPTS);
  let r = null;
  for (let i = 0; i < ms(300); i++) r ??= ep.push(frame("noise")); // the mic warms up in a quiet room
  ep.setIgnoring(true);
  for (let i = 0; i < ms(450); i++) r ??= ep.push(frame("speech")); // the chime, loud and longer than a cough
  ep.setIgnoring(false);
  for (let i = 0; i < ms(1500); i++) r ??= ep.push(frame("noise")); // without ignoring, this pause would end the "turn" here
  assert.equal(r, null, "the chime didn't count as the user's answer");
  assert.equal(ep.speechStartFrame, -1);
  for (let i = 0; i < ms(1500); i++) r ??= ep.push(frame("speech")); // the real answer
  for (let i = 0; i < ms(2000) && !r; i++) r = ep.push(frame("noise"));
  assert.equal(r, "end-of-turn");
  assert.equal(ep.speechStartFrame, ms(300) + ms(450) + ms(1500), "the answer starts where the user started, not at the chime");

  // Time spent ignoring still counts toward the start timeout.
  const quiet = new Endpointer({ ...OPTS, startTimeoutMs: 1000 });
  quiet.setIgnoring(true);
  let reason = null;
  for (let i = 0; i < ms(1200) && !reason; i++) reason = quiet.push(frame("noise"));
  assert.equal(reason, "no-speech");
});

test("the last frame's level and threshold: speech sits above the threshold, a quiet room below it", () => {
  const ep = new Endpointer(OPTS);
  for (let i = 0; i < ms(1000); i++) ep.push(frame("noise"));
  assert.equal(ep.lastThresholdDb, -48, "a quiet room's threshold is the -48 dB floor");
  assert.ok(ep.lastDb < ep.lastThresholdDb, `room ${ep.lastDb} dB is under ${ep.lastThresholdDb} dB`);
  ep.push(frame("speech"));
  assert.ok(ep.lastDb > ep.lastThresholdDb, `speech ${ep.lastDb} dB is over ${ep.lastThresholdDb} dB`);
});

// --- level-exact synthetic frames (a sine at a given dBFS) for the turn-taking regressions ---
function toneFrame(db) {
  const buf = Buffer.alloc(FRAME_SAMPLES * 2);
  const amp = db === null ? 0 : Math.SQRT2 * 32768 * 10 ** (db / 20);
  for (let i = 0; i < FRAME_SAMPLES; i++) buf.writeInt16LE(Math.round(amp * Math.sin(i / 5) + rand() * 3), i * 2);
  return buf;
}
const LONG = { maxMs: 30_000, startTimeoutMs: 15_000, endSilenceMs: 1_500, marginDb: 12, minSpeechDb: -48 };

/** Script of [dB, ms] segments, then -60 dB room forever. Returns [reason, endpointer, framesFed]. */
function runLevels(script, opts = LONG) {
  const ep = new Endpointer(opts);
  let fed = 0;
  const levels = script.flatMap(([db, dur]) => Array(ms(dur)).fill(db));
  const total = ms(opts.maxMs + opts.startTimeoutMs) + 100;
  for (let i = 0; i < total; i++) {
    fed++;
    const r = ep.push(toneFrame(i < levels.length ? levels[i] : -60));
    if (r) return [r, ep, fed];
  }
  return [null, ep, fed];
}

test("a short answer like \"yes\" (210 ms and 270 ms) ends the turn as end-of-turn", () => {
  for (const dur of [210, 270]) {
    const [reason, ep] = runLevels([[-60, 1000], [-25, dur]]);
    assert.equal(reason, "end-of-turn", `${dur} ms yes`);
    assert.ok(ep.speechStartFrame >= 0);
  }
});

test("a very short click (90 ms) is still ignored", () => {
  const [reason] = runLevels([[-60, 1000], [-25, 90]]);
  assert.equal(reason, "no-speech");
});

test("max duration counts from when the user starts talking, not from the start of listening", () => {
  const [reason, , fed] = runLevels([[-60, 12_000], [-25, 25_000]]);
  assert.equal(reason, "end-of-turn");
  assert.ok(fed * FRAME_MS > 37_000, `ended at ${fed * FRAME_MS} ms`);
});

test("talking past the limit from speech start still gives max-duration", () => {
  const [reason, , fed] = runLevels([[-60, 12_000], [-25, 60_000]]);
  assert.equal(reason, "max-duration");
  assert.ok(Math.abs(fed * FRAME_MS - 42_000) < 200, `stopped at ${fed * FRAME_MS} ms`);
});

test("speech that varies only 8 or 10 dB between syllables does not end the turn early", () => {
  for (const low of [-33, -35]) {
    const script = [[-60, 1000]];
    for (let i = 0; i < 24; i++) script.push([-25, 210], [low, 210]); // ~10 s of syllables, no pauses
    const speechEndMs = ms(1000) * FRAME_MS + 24 * 2 * ms(210) * FRAME_MS;
    const [reason, , fed] = runLevels(script);
    assert.equal(reason, "end-of-turn", `-25/${low}`);
    const afterSpeechMs = fed * FRAME_MS - speechEndMs;
    assert.ok(afterSpeechMs >= 1400 && afterSpeechMs <= 2100, `-25/${low}: ended ${afterSpeechMs} ms after speech stopped`);
  }
});

test("speech that goes softer for a few seconds after a loud start is not cut off", () => {
  // Review finding: releasing the floor cap 0.6 s after the last strong syllable ended this turn
  // about 1 s before the soft part did.
  const script = [[-60, 1000]];
  for (let i = 0; i < 6; i++) script.push([-25, 210], [-30, 210]); // ~2.5 s at a normal level
  for (let i = 0; i < 7; i++) script.push([-34, 210], [-40, 210]); // ~3 s trailing off, 9-10 dB softer
  const softEndMs = 1000 + 26 * 210;
  const [reason, , fed] = runLevels(script);
  assert.equal(reason, "end-of-turn");
  const afterSoftMs = fed * FRAME_MS - softEndMs;
  assert.ok(afterSoftMs >= 1400, `ended ${afterSoftMs} ms after the soft speech, i.e. during it`);
});

test("words said over the mic-open chime are kept: the utterance starts where the chime did", () => {
  const ep = new Endpointer(OPTS);
  let r = null;
  for (let i = 0; i < ms(300); i++) r ??= ep.push(frame("noise")); // mic warm-up
  const chimeFrame = ms(300);
  ep.setIgnoring(true);
  for (let i = 0; i < ms(600); i++) r ??= ep.push(frame("speech")); // the user is already talking under the tick
  ep.setIgnoring(false);
  for (let i = 0; i < ms(1500); i++) r ??= ep.push(frame("speech"));
  for (let i = 0; i < ms(2000) && !r; i++) r = ep.push(frame("noise"));
  assert.equal(r, "end-of-turn");
  assert.equal(ep.speechStartFrame, chimeFrame, "starts at the chime, not after it");
  const [first] = ep.trimRange(ms(5000));
  assert.ok(first <= chimeFrame, "the trimmed audio keeps the words said over the chime");
});

test("speech that begins late under the chime starts where it began, not at the chime (no extra quiet kept)", () => {
  const ep = new Endpointer(OPTS);
  let r = null;
  for (let i = 0; i < ms(300); i++) r ??= ep.push(frame("noise"));
  ep.setIgnoring(true); // the chime window: quiet room, then the user starts near its end
  for (let i = 0; i < ms(900); i++) r ??= ep.push(frame("noise"));
  const voiceFrame = ms(1200);
  for (let i = 0; i < ms(150); i++) r ??= ep.push(frame("speech"));
  ep.setIgnoring(false);
  for (let i = 0; i < ms(1500); i++) r ??= ep.push(frame("speech"));
  for (let i = 0; i < ms(2000) && !r; i++) r = ep.push(frame("noise"));
  assert.equal(r, "end-of-turn");
  assert.equal(ep.speechStartFrame, voiceFrame);
});

test("a loud chime followed by quiet doesn't pull the start back to the chime", () => {
  const ep = new Endpointer(OPTS);
  let r = null;
  for (let i = 0; i < ms(300); i++) r ??= ep.push(frame("noise"));
  ep.setIgnoring(true);
  for (let i = 0; i < ms(150); i++) r ??= ep.push(frame("loudnoise")); // the tick itself, loud at the mic
  for (let i = 0; i < ms(600); i++) r ??= ep.push(frame("noise")); // its tail: quiet room
  const voiceFrame = ms(1050);
  for (let i = 0; i < ms(150); i++) r ??= ep.push(frame("speech"));
  ep.setIgnoring(false);
  for (let i = 0; i < ms(1500); i++) r ??= ep.push(frame("speech"));
  for (let i = 0; i < ms(2000) && !r; i++) r = ep.push(frame("noise"));
  assert.equal(r, "end-of-turn");
  assert.equal(ep.speechStartFrame, voiceFrame);
});

// --- Replay of Jeet's live run, 2026-11-14 07:00 (local-test-results/2026-11-14T07-00-52-384Z.json) ----------
// The flight recorder (mode "on") keeps one summary per turn, not frame levels, so each turn is rebuilt from
// what it recorded: the room's mean and spread (recentDb ± recentSpreadDb), the voice at turn 3's level (the same
// sentence, voice and speaker: speechDb -19.08), and, after the sentence, short quiet sounds just over the
// -48 dBFS minimum. Before the fix, turns 1 and 2 ran on 8.6 s and 11.2 s here (10.0 s and 13.4 s live), with
// the voice level dragged down to -43.7 and -45.5 (-41.72 and -45.51 recorded) and the floor capped 24 dB
// under it (-65.72 and -69.51 recorded): those room sounds counted as the user, every 1.5 s.
const JEET = { maxMs: 25_000, startTimeoutMs: 8_000, endSilenceMs: 2_000, marginDb: 10, minSpeechDb: -48 };
function replayTurn({ roomDb, roomSd, tailDb, tailDuty, tailMs }) {
  let s = 7;
  const u = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const g = () => { let t = 0; for (let i = 0; i < 6; i++) t += u(); return (t - 3) * Math.SQRT2; };
  const room = () => roomDb + roomSd * g();
  const levels = [];
  for (let i = 0; i < ms(1300); i++) levels.push(room()); // the harness waits 1.3 s after the tick
  for (let i = 0; i < ms(4600); i++) { // the sentence: syllables ~4/s, quiet gaps between words
    const syl = Math.sin(2 * Math.PI * 4 * i * (FRAME_MS / 1000));
    levels.push(syl > -0.6 ? -22 + 8 * syl + 2 * g() : room());
  }
  const speechEnd = levels.length;
  for (let i = 0; i < ms(tailMs); i++) levels.push(i % 50 < Math.round(50 * tailDuty) ? tailDb + 1.5 * g() : room());
  const ep = new Endpointer(JEET);
  for (let i = 0; i < levels.length + ms(25_000); i++) {
    const r = ep.push(toneFrame(i < levels.length ? levels[i] : room()));
    if (r) return { reason: r, afterSpeechMs: (i + 1 - speechEnd) * FRAME_MS, ep };
  }
  return { reason: null, afterSpeechMs: Infinity, ep };
}

test("replay of Jeet's slow turns: quiet room sounds far below the voice don't hold the turn open", () => {
  const turns = {
    "turn 1 (10.02 s live)": { roomDb: -59.78, roomSd: 2.63, tailDb: -44, tailDuty: 0.35, tailMs: 7000 },
    "turn 2 (13.40 s live)": { roomDb: -54.07, roomSd: 1.98, tailDb: -46, tailDuty: 0.16, tailMs: 10300 },
    "turn 3 (3.03 s live)": { roomDb: -52.95, roomSd: 1.97, tailDb: -46, tailDuty: 0, tailMs: 0 },
  };
  for (const [name, spec] of Object.entries(turns)) {
    const { reason, afterSpeechMs, ep } = replayTurn(spec);
    assert.equal(reason, "end-of-turn", name);
    assert.ok(afterSpeechMs >= 1900 && afterSpeechMs <= 2300, `${name}: ended ${afterSpeechMs} ms after the speech`);
    assert.ok(ep.diagnostics().speechDb > -30, `${name}: voice level dragged to ${ep.diagnostics().speechDb.toFixed(1)} dB`);
  }
});

test("speech that suddenly drops 18 dB is still the user and is kept (as before the fix)", () => {
  // The voice gate must not cut anything the floor cap already kept: both keep an 18 dB drop, both lose 20 dB.
  const script = [[-60, 1000]];
  for (let i = 0; i < 6; i++) script.push([-20, 210], [-26, 210]); // ~2.5 s at a normal level
  for (let i = 0; i < 9; i++) script.push([-38, 210], [-44, 210]); // ~3.8 s, 18 dB softer at once
  const softEndMs = 1000 + 30 * 210;
  const [reason, , fed] = runLevels(script, JEET);
  assert.equal(reason, "end-of-turn");
  assert.ok(fed * FRAME_MS - softEndMs >= 1900, `ended ${fed * FRAME_MS - softEndMs} ms after the soft speech, i.e. during it`);
});

test("a loud cough or first word, a pause, then speech 20-30 dB softer: the softer speech is kept", () => {
  // Review finding on the voice gate: the loud start set the voice level, and everything after it was gated out.
  for (const [loudDb, loudMs, voiceDb] of [[-10, 400, -30], [-8, 500, -38]]) {
    const script = [[-60, 1000], [loudDb, loudMs], [-60, 300]];
    for (let i = 0; i < 10; i++) script.push([voiceDb, 210], [voiceDb - 6, 210]); // ~4.2 s of speech
    const speechEndMs = 1000 + loudMs + 300 + 20 * 210;
    const [reason, ep, fed] = runLevels(script, JEET);
    assert.equal(reason, "end-of-turn");
    const after = fed * FRAME_MS - speechEndMs;
    assert.ok(after >= 1900, `${loudDb} dB start, ${voiceDb} dB speech: ended ${after} ms after the speech, i.e. during it`);
    assert.ok(ep.lastVoicedFrame * FRAME_MS >= speechEndMs - 300, `${loudDb}/${voiceDb}: last voiced at ${ep.lastVoicedFrame * FRAME_MS} ms, so the speech would be trimmed off`);
  }
});
