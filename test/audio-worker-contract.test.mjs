// The real native worker (native/audio-worker.swift) against the protocol module it mirrors
// (src/audio/protocol.ts). Built here with swiftc and run with --no-device, where what it plays comes
// straight back as mic audio: no microphone, no permission, no sound. Every fd-3 line it writes must
// parse. VOICE_MCP_TEST_AUDIO_DEVICE=1 adds a run on the real voice-processing unit (it plays a quiet
// tone and needs mic permission).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { ACK_STATUSES, DONE_REASONS, DUCK_LEVELS, ERROR_STAGES, EVENTS, FRAME_BYTES, OPS, PROTOCOL_VERSION, ROUTES } from "../dist/audio/protocol.js";
import { killWorkers, sleep, startWorker, tone } from "./stubs/worker-client.mjs";

afterEach(killWorkers);

const SOURCE = fileURLToPath(new URL("../native/audio-worker.swift", import.meta.url));

test("the Swift worker names the protocol's version and every command, event and enum value", () => {
  const swift = readFileSync(SOURCE, "utf8");
  assert.match(swift, new RegExp(`^let protocolVersion = ${PROTOCOL_VERSION}$`, "m"));
  assert.match(swift, new RegExp(`^let frameBytes = ${FRAME_BYTES}$`, "m"));
  for (const word of [...OPS, ...EVENTS, ...ACK_STATUSES, ...DONE_REASONS, ...ERROR_STAGES, ...ROUTES, ...DUCK_LEVELS]) assert.ok(swift.includes(`"${word}"`), `"${word}"`);
});

// The worker's atomics need macOS 15 (Darwin 24) and Swift 6.
const canBuild = process.platform === "darwin" && Number(os.release().split(".")[0]) >= 24 && spawnSync("xcode-select", ["-p"]).status === 0;
const skip = process.env.CI ? "not run on CI" : !canBuild && "needs macOS 15 or later with swiftc";
const DIR = skip ? "" : mkdtempSync(path.join(os.tmpdir(), "voice-audio-worker-"));
const BIN = path.join(DIR, "audio-worker");

const TONE_PEAK = 0.25 * 32767;
/** The largest step between two samples of the test tone (440 Hz) at full gain, at the mic's 16 kHz. */
const TONE_STEP = TONE_PEAK * 2 * Math.sin((Math.PI * 440) / 16000);

const samples = (pcm) => Array.from({ length: pcm.length >> 1 }, (_, i) => pcm.readInt16LE(i * 2));
const peak = (values) => values.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
/** The loudest sample in the last `ms` of mic audio. */
const recentPeak = (worker, ms) => peak(samples(worker.mic().subarray(-ms * 32)));
const near = (actual, expected, tolerance, what) => assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual}, expected ${expected} ± ${tolerance}`);

function wav(pcm, rate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function hangUp(worker) {
  worker.child.stdin.end();
  const exit = await worker.exit;
  await sleep(20);
  assert.deepEqual(worker.malformed, [], "every fd-3 line is a protocol event");
  assert.equal(worker.mic().length % FRAME_BYTES, 0, "mic audio in whole frames");
  return exit;
}

/** A playing sound's position: every command that names it is answered with one. */
const position = async (worker, id, value = 1) => (await worker.send({ op: "gain", id, value, rampMs: 0 })).playedMs;

test("swiftc builds the worker without a warning", { skip }, () => {
  const built = spawnSync("swiftc", ["-O", SOURCE, "-o", BIN], { encoding: "utf8" });
  assert.equal(built.stderr, "");
  assert.equal(built.status, 0);
});

test("ready, a silent mic, then a played tone comes back; gain ramps and is answered with the position", { skip }, async () => {
  const worker = startWorker(BIN, ["--no-device"]);
  assert.deepEqual({ ...(await worker.waitFor((e) => e.ev === "ready")), at: 0 }, { ev: "ready", v: PROTOCOL_VERSION, rate: 48000, aec: true, at: 0 });
  await sleep(200);
  assert.ok(worker.mic().length >= 4 * FRAME_BYTES, `frames flow: ${worker.mic().length} bytes in 200 ms`);
  assert.equal(recentPeak(worker, 200), 0, "nothing playing, nothing heard");

  assert.deepEqual({ ...(await worker.send({ op: "play", id: 1, rate: 24000 })), at: 0 }, { ev: "ack", seq: 1, op: "play", status: "ok", playedMs: 0, at: 0 });
  await worker.sendPcm(1, tone(3, 24000), 24000);
  await sleep(300);
  near(recentPeak(worker, 60), TONE_PEAK, TONE_PEAK * 0.1, "tone at full gain");

  const ack = await worker.send({ op: "gain", id: 1, value: 0.3, rampMs: 10 });
  assert.equal(ack.status, "ok");
  assert.ok(ack.playedMs > 200 && ack.playedMs < 700, `position with the ack: ${ack.playedMs}`);
  await sleep(150);
  near(recentPeak(worker, 60), TONE_PEAK * 0.3, TONE_PEAK * 0.03, "tone at gain 0.3");

  const positions = worker.events.filter((e) => e.ev === "pos").map((e) => e.playedMs);
  assert.ok(positions.length >= 3, `pos events: ${positions}`);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), "positions only move forward");
  near(positions[2] - positions[1], 100, 25, "pos about every 100 ms");
  assert.deepEqual(await hangUp(worker), { code: 0, signal: null });
  const steps = samples(worker.mic()).map((v, i, all) => Math.abs(v - (all[i - 1] ?? 0)));
  assert.ok(peak(steps) < TONE_STEP * 1.5, `no click on the gain ramp or the closing fade: largest step ${peak(steps)}, the tone's own is ${Math.round(TONE_STEP)}`);
});

test("pause holds the exact position and resume continues from it, without a click; stop fades and done follows at once", { skip }, async () => {
  const worker = startWorker(BIN, ["--no-device"]);
  await worker.send({ op: "play", id: 1, rate: 24000 });
  await worker.sendPcm(1, tone(3, 24000), 24000);
  await sleep(200);
  let resumedAt = 0;
  for (let round = 0; round < 3; round++) {
    await sleep(60);
    assert.equal((await worker.send({ op: "pause", id: 1 })).status, "ok");
    await sleep(120);
    const held = await position(worker, 1);
    assert.ok(held > resumedAt, `it played between the pauses: ${resumedAt} then ${held}`);
    await sleep(150);
    assert.equal(await position(worker, 1), held, "position held while paused");
    assert.equal(recentPeak(worker, 100), 0, "silent while paused");
    assert.equal((await worker.send({ op: "resume", id: 1 })).status, "ok");
    await sleep(120);
    resumedAt = await position(worker, 1);
    assert.ok(resumedAt > held + 50, `it plays again after resume: ${held} then ${resumedAt}`);
  }
  const stopped = await worker.send({ op: "stop", id: 1 });
  const done = await worker.waitFor((e) => e.ev === "done");
  assert.deepEqual({ id: done.id, reason: done.reason }, { id: 1, reason: "stopped" });
  assert.ok(done.at - stopped.at < 60, `done ${done.at - stopped.at} ms after the stop was acknowledged`);
  assert.ok(done.playedMs >= resumedAt && done.playedMs < 2500, `stopped at ${done.playedMs}`);
  assert.equal((await worker.send({ op: "resume", id: 1 })).status, "unknown-id", "the sound is gone after done");
  await sleep(100);
  await hangUp(worker);

  const heard = samples(worker.mic());
  const steps = heard.map((v, i) => Math.abs(v - (heard[i - 1] ?? 0)));
  assert.ok(peak(steps) < TONE_STEP * 1.5, `no click: largest step ${peak(steps)}, the tone's own is ${Math.round(TONE_STEP)}`);
  near(heard.filter((v) => v !== 0).length / 16, done.playedMs, 20, "ms of sound heard, against the position reported");
});

test("a sound plays out to its length and is done finished; a cue file plays; refusals carry a status", { skip }, async () => {
  const worker = startWorker(BIN, ["--no-device"]);
  const started = await worker.send({ op: "play", id: 5, rate: 16000, gain: 0.5 });
  await worker.sendPcm(5, tone(0.2, 16000), 16000);
  await worker.send({ op: "end", id: 5 });
  const done = await worker.waitFor((e) => e.ev === "done" && e.id === 5);
  assert.equal(done.reason, "finished");
  near(done.playedMs, 200, 5, "played its length");
  near(done.at - started.at, 200, 60, "done as the sound ends");

  const cue = path.join(DIR, "cue.wav");
  const pcm = tone(0.1, 16000);
  writeFileSync(cue, wav(pcm, 16000));
  assert.equal((await worker.send({ op: "play", id: 6, file: cue })).status, "ok");
  const cueDone = await worker.waitFor((e) => e.ev === "done" && e.id === 6);
  assert.equal(cueDone.reason, "finished");
  near(cueDone.playedMs, 100, 5, "the cue's length");
  near(peak(samples(worker.mic())), TONE_PEAK, TONE_PEAK * 0.1, "the cue was heard at full gain, the sound before it at half");

  const missing = await worker.send({ op: "play", id: 7, file: path.join(DIR, "missing.wav") });
  assert.deepEqual({ status: missing.status, code: missing.code }, { status: "failed", code: -1 });
  assert.equal((await worker.send({ op: "gain", id: 99, value: 0.3 })).status, "unknown-id");
  for (const command of [{ op: "aec", on: false }, { op: "aec", on: true }, { op: "agc", on: true }, ...DUCK_LEVELS.map((level) => ({ op: "duck-others", level }))]) {
    assert.equal((await worker.send(command)).status, "ok", JSON.stringify(command));
  }
  worker.write("not json");
  assert.deepEqual({ ...(await worker.waitFor((e) => e.ev === "ack" && e.seq === -1)), at: 0 }, { ev: "ack", seq: -1, op: "", status: "bad-command", at: 0 });
  for (const [seq, line] of [
    [901, '{"op":"rewind","id":1,"seq":901}'],
    [902, '{"op":"duck-others","level":"lots","seq":902}'],
    [903, '{"op":"pcm","id":1,"b64":"!","seq":903}'],
    [904, '{"op":"play","id":8,"seq":904}'],
  ]) {
    worker.write(line);
    assert.equal((await worker.waitFor((e) => e.ev === "ack" && e.seq === seq)).status, "bad-command", line);
  }

  for (let id = 10; id < 18; id++) assert.equal((await worker.send({ op: "play", id, rate: 24000 })).status, "ok");
  assert.equal((await worker.send({ op: "play", id: 18, rate: 24000 })).status, "busy", "eight sounds at once");
  assert.equal((await worker.send({ op: "play", id: 10, rate: 24000 })).status, "bad-command", "the id is in use");
  assert.deepEqual(await hangUp(worker), { code: 0, signal: null });
  const settled = worker.events.filter((e) => e.ev === "done" && e.id >= 10);
  assert.deepEqual(settled.map((e) => `${e.id} ${e.reason}`), [10, 11, 12, 13, 14, 15, 16, 17].map((id) => `${id} stopped`), "closing settles every sound");
  assert.equal(worker.events.at(-1).ev, "mic-closed");
});

test("mic frames nobody reads are dropped and counted, and the stream stays in whole frames", { skip }, async () => {
  const worker = startWorker(BIN, ["--no-device"]);
  await worker.waitFor((e) => e.ev === "ready");
  worker.child.stdout.pause();
  const dropped = await worker.waitFor((e) => e.ev === "frames-dropped", 15_000, "frames-dropped");
  assert.ok(dropped.count > 0, `dropped ${dropped.count}`);
  assert.equal((await worker.send({ op: "agc", on: true })).status, "ok", "commands are still answered");
  worker.child.stdout.resume();
  await sleep(300);
  const before = worker.mic().length;
  await sleep(200);
  assert.ok(worker.mic().length - before >= 4 * FRAME_BYTES, "frames flow again once read");
  await hangUp(worker);
});

test("a device change is reported and ends the worker cleanly; so do SIGTERM and stdin EOF", { skip }, async () => {
  const worker = startWorker(BIN, ["--no-device"]);
  await worker.send({ op: "play", id: 1, rate: 24000 });
  await worker.sendPcm(1, tone(1, 24000), 24000);
  worker.child.kill("SIGUSR1");
  assert.deepEqual(await worker.exit, { code: 0, signal: null });
  await sleep(20);
  const last = worker.events.slice(-3).map(({ at, ...event }) => event);
  assert.deepEqual(last.map((e) => e.ev), ["route-changed", "done", "mic-closed"]);
  assert.deepEqual(last[0], { ev: "route-changed", which: "output" });
  assert.equal(last[1].reason, "stopped");
  assert.deepEqual(worker.malformed, []);

  const terminated = startWorker(BIN, ["--no-device", "--no-aec"]);
  assert.equal((await terminated.waitFor((e) => e.ev === "ready")).aec, false);
  terminated.child.kill("SIGTERM");
  assert.deepEqual(await terminated.exit, { code: 0, signal: null });
  await sleep(20);
  assert.deepEqual(terminated.events.map((e) => e.ev), ["ready", "mic-closed"]);

  const closed = startWorker(BIN, ["--no-device"]);
  await closed.waitFor((e) => e.ev === "ready");
  assert.deepEqual(await hangUp(closed), { code: 0, signal: null });
  assert.deepEqual(closed.events.map((e) => e.ev), ["ready", "mic-closed"]);
});

test("a mic that stops delivering audio ends the worker with an error", { skip }, async () => {
  const worker = startWorker(BIN, ["--no-device"]);
  await worker.waitFor((e) => e.ev === "ready");
  const stalledAt = Date.now();
  worker.child.kill("SIGUSR2");
  assert.deepEqual(await worker.exit, { code: 1, signal: null });
  near(Date.now() - stalledAt, 2000, 300, "ms until it gave up");
  await sleep(20);
  const [error, closed] = worker.events.slice(-2).map(({ at, ...event }) => event);
  assert.deepEqual(error, { ev: "error", stage: "run", code: 0, message: "the microphone stopped delivering audio" });
  assert.deepEqual(closed, { ev: "mic-closed" });
});

test("on the real voice-processing unit: frames, a tone, pause and resume, stop, clean exit", { skip: skip || (!process.env.VOICE_MCP_TEST_AUDIO_DEVICE && "set VOICE_MCP_TEST_AUDIO_DEVICE=1 (plays a quiet tone, needs mic permission)") }, async () => {
  const worker = startWorker(BIN);
  const ready = await worker.waitFor((e) => e.ev === "ready" || e.ev === "error", 10_000, "ready");
  assert.deepEqual({ ev: ready.ev, v: ready.v, aec: ready.aec }, { ev: "ready", v: PROTOCOL_VERSION, aec: true }, JSON.stringify(ready));
  await sleep(500);
  assert.ok(worker.mic().length >= 10 * FRAME_BYTES, `frames flow: ${worker.mic().length} bytes in 500 ms`);
  assert.ok(recentPeak(worker, 300) > 0, "the mic is not all zeros");

  assert.equal((await worker.send({ op: "play", id: 1, rate: 24000, gain: 0.2 })).status, "ok");
  await worker.sendPcm(1, tone(3, 24000), 24000);
  await sleep(300);
  const ducked = await worker.send({ op: "gain", id: 1, value: 0.06, rampMs: 10 });
  assert.equal(ducked.status, "ok");
  assert.ok(ducked.playedMs > 150 && ducked.playedMs < 800, `position with the ack: ${ducked.playedMs}`);
  await worker.send({ op: "pause", id: 1 });
  await sleep(120);
  const held = await position(worker, 1, 0.06);
  await sleep(200);
  assert.equal(await position(worker, 1, 0.06), held, "position held while paused");
  await worker.send({ op: "resume", id: 1 });
  await sleep(200);
  assert.ok((await position(worker, 1, 0.06)) > held + 100, "it plays again after resume");
  for (const command of [{ op: "aec", on: false }, { op: "aec", on: true }, { op: "agc", on: true }, { op: "duck-others", level: "min" }]) {
    assert.deepEqual({ status: (await worker.send(command)).status }, { status: "ok" }, JSON.stringify(command));
  }
  const stopped = await worker.send({ op: "stop", id: 1 });
  const done = await worker.waitFor((e) => e.ev === "done");
  assert.equal(done.reason, "stopped");
  assert.ok(done.at - stopped.at < 100, `done ${done.at - stopped.at} ms after the stop was acknowledged`);
  assert.deepEqual(await hangUp(worker), { code: 0, signal: null });
  assert.equal(worker.events.at(-1).ev, "mic-closed");
  assert.deepEqual(worker.events.filter((e) => ["error", "route-changed", "frames-dropped"].includes(e.ev)), [], "nothing went wrong on the way");
  console.log(`device run: unit at ${ready.rate} Hz, ${worker.mic().length / FRAME_BYTES} mic frames, stopped at ${done.playedMs} ms, done ${done.at - stopped.at} ms after the stop ack`);
});
