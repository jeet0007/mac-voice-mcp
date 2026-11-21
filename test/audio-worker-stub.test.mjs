// The Node stub of the audio worker (test/stubs/audio-worker.mjs): the test double the call's
// native-backend tests will run against. It must speak the protocol and keep a command log to assert on.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { FRAME_BYTES, PROTOCOL_VERSION } from "../dist/audio/protocol.js";
import { killWorkers, sleep, startWorker, tone } from "./stubs/worker-client.mjs";

afterEach(killWorkers);

const STUB = fileURLToPath(new URL("./stubs/audio-worker.mjs", import.meta.url));

function stub(env = {}, args = []) {
  const log = path.join(mkdtempSync(path.join(os.tmpdir(), "voice-worker-stub-")), "log.txt");
  writeFileSync(log, "");
  const worker = startWorker(process.execPath, [STUB, ...args], { ...process.env, STUB_LOG: log, STUB_SCENARIO: "silent", ...env });
  const entries = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => ({ line: line.replace(/ @\d+$/, ""), at: Number(line.match(/ @(\d+)$/)[1]) }));
  return { ...worker, log, entries, lines: () => entries().map((e) => e.line) };
}

/** Close stdin and wait for the exit. Every event must have parsed. */
async function hangUp(worker) {
  worker.child.stdin.end();
  const exit = await worker.exit;
  assert.deepEqual(worker.malformed, [], "every fd-3 line is a protocol event");
  return exit;
}

const loudest = (pcm) => {
  let max = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) max = Math.max(max, Math.abs(pcm.readInt16LE(i)));
  return max;
};

test("the stub says ready, streams the scenario's mic audio in whole frames, and closes on stdin EOF", async () => {
  const worker = stub({ STUB_SCENARIO: "answer" });
  assert.deepEqual({ ...(await worker.waitFor((e) => e.ev === "ready")), at: 0 }, { ev: "ready", v: PROTOCOL_VERSION, rate: 48000, aec: true, at: 0 });
  await sleep(400); // the answer's speech starts 1 s in, played at 10x
  assert.deepEqual(await hangUp(worker), { code: 0, signal: null });
  assert.equal(worker.mic().length % FRAME_BYTES, 0, "whole frames only");
  assert.ok(worker.mic().length >= 20 * FRAME_BYTES, `${worker.mic().length} bytes of mic audio`);
  assert.ok(loudest(worker.mic()) > 7000, "the scenario's speech is in the stream");
  assert.equal(worker.events.at(-1).ev, "mic-closed");
  assert.deepEqual(worker.lines(), ["worker start aec=1", "worker mic-closed"]);
});

test("gain and stop are acknowledged and logged with their times; a stopped sound is done stopped", async () => {
  const worker = stub();
  assert.equal((await worker.send({ op: "play", id: 1, rate: 24000 })).status, "ok");
  await worker.sendPcm(1, tone(2, 24000), 24000);
  await sleep(150);
  const sent = Date.now();
  const ack = await worker.send({ op: "gain", id: 1, value: 0.3, rampMs: 10 });
  assert.equal(ack.status, "ok");
  assert.ok(ack.playedMs >= 100 && ack.playedMs < 600, `position with the ack: ${ack.playedMs}`);
  const gain = worker.entries().find((e) => e.line === "worker gain 1 0.3");
  assert.ok(gain.at - sent < 100, `gain logged ${gain.at - sent} ms after it was sent`);

  const stopped = await worker.send({ op: "stop", id: 1 });
  assert.equal(stopped.status, "ok");
  const done = await worker.waitFor((e) => e.ev === "done");
  assert.deepEqual({ id: done.id, reason: done.reason }, { id: 1, reason: "stopped" });
  assert.ok(worker.events.indexOf(done) > worker.events.indexOf(stopped), "done follows the stop's ack, as on the real worker");
  assert.ok(done.playedMs >= ack.playedMs && done.playedMs < 2000);
  assert.equal((await worker.send({ op: "gain", id: 1, value: 1 })).status, "unknown-id", "the sound is gone after done");
  await hangUp(worker);
  assert.deepEqual(worker.lines(), ["worker start aec=1", "worker play 1 speech 24000", "worker gain 1 0.3", "worker stop 1", "worker done 1 stopped", "worker mic-closed"]);
});

test("a sound plays out to its exact length, reports its position on the way, and holds it while paused", async () => {
  const worker = stub();
  await worker.send({ op: "play", id: 2, rate: 16000, gain: 0.5 });
  await worker.sendPcm(2, tone(0.4, 16000), 16000);
  await worker.send({ op: "end", id: 2 });
  const paused = await worker.send({ op: "pause", id: 2 });
  await sleep(200);
  const resumed = await worker.send({ op: "resume", id: 2 });
  assert.equal(resumed.playedMs, paused.playedMs, "position held while paused");
  const done = await worker.waitFor((e) => e.ev === "done");
  assert.deepEqual({ id: done.id, reason: done.reason, playedMs: done.playedMs }, { id: 2, reason: "finished", playedMs: 400 });
  assert.ok(worker.events.some((e) => e.ev === "pos" && e.id === 2 && e.playedMs > 0 && e.playedMs < 400), "pos on the way");

  await worker.send({ op: "play", id: 3, file: "/tmp/chime.wav" });
  assert.deepEqual((await worker.waitFor((e) => e.ev === "done" && e.id === 3)).reason, "finished");
  for (const command of [{ op: "aec", on: false }, { op: "agc", on: true }, { op: "duck-others", level: "min" }]) assert.equal((await worker.send(command)).status, "ok");
  await hangUp(worker);
  assert.deepEqual(worker.lines(), [
    "worker start aec=1",
    "worker play 2 speech 16000",
    "worker end 2",
    "worker pause 2",
    "worker resume 2",
    "worker done 2 finished",
    "worker play 3 cue /tmp/chime.wav",
    "worker done 3 finished",
    "worker aec off",
    "worker agc on",
    "worker duck-others min",
    "worker mic-closed",
  ]);
});

test("a line the stub can't read is acknowledged as a bad command, by seq when it has one", async () => {
  const worker = stub();
  worker.write("not json");
  assert.deepEqual({ ...(await worker.waitFor((e) => e.ev === "ack")), at: 0 }, { ev: "ack", seq: -1, op: "", status: "bad-command", at: 0 });
  worker.write('{"op":"rewind","seq":41}');
  assert.equal((await worker.waitFor((e) => e.ev === "ack" && e.seq === 41)).status, "bad-command");
  await worker.send({ op: "play", id: 1, rate: 24000 });
  worker.write('{"op":"play","id":1,"rate":24000,"seq":42}');
  assert.equal((await worker.waitFor((e) => e.ev === "ack" && e.seq === 42)).status, "bad-command", "the id is in use");
  await hangUp(worker);
  assert.deepEqual(worker.events.filter((e) => e.ev === "done").map((e) => e.reason), ["stopped"], "closing settles the sound still playing");
});

test("the user talks over a reply in the bargein scenario, and on demand in the talk scenario", async () => {
  const barge = stub({ STUB_SCENARIO: "bargein", STUB_BARGEIN_MS: "200" });
  await barge.send({ op: "play", id: 1, rate: 24000 });
  await sleep(150);
  assert.ok(loudest(barge.mic()) < 100, "only room noise before the reply plays");
  await barge.sendPcm(1, tone(1, 24000), 24000);
  await sleep(500);
  assert.ok(loudest(barge.mic()) > 7000, "speech after 200 ms of the reply");
  await hangUp(barge);
  assert.deepEqual(barge.lines().slice(1, 3), ["worker play 1 speech 24000", "worker speech-onset"]);

  const talk = stub({ STUB_SCENARIO: "talk" });
  await talk.waitFor((e) => e.ev === "ready");
  await sleep(100);
  assert.ok(loudest(talk.mic()) < 100);
  writeFileSync(`${talk.log}.talk`, "");
  await sleep(300);
  assert.ok(loudest(talk.mic()) > 7000);
  await hangUp(talk);
});

test("the stub can fail to start, die, lose its output device, and be stopped by SIGTERM", async () => {
  const failed = stub({ STUB_WORKER: "fail-start" });
  assert.deepEqual(await failed.exit, { code: 1, signal: null });
  await sleep(50);
  assert.deepEqual(failed.events.map((e) => e.ev), ["error"]);
  assert.equal(failed.events[0].stage, "start");

  const dies = stub({ STUB_WORKER: "dies" });
  assert.deepEqual(await dies.exit, { code: 1, signal: null });
  await sleep(50);
  assert.deepEqual(dies.events.map((e) => e.ev), ["ready"], "no goodbye");

  const route = stub({ STUB_WORKER: "route" });
  await route.send({ op: "play", id: 1, rate: 24000 });
  assert.deepEqual(await route.exit, { code: 0, signal: null });
  await sleep(50);
  assert.deepEqual(route.events.filter((e) => e.ev !== "ack").map((e) => e.ev), ["ready", "route-changed", "done", "mic-closed"]);

  const stopped = stub({}, ["--no-aec"]);
  assert.equal((await stopped.waitFor((e) => e.ev === "ready")).aec, false);
  stopped.child.kill("SIGTERM");
  assert.deepEqual(await stopped.exit, { code: 0, signal: null });
  assert.deepEqual(stopped.lines(), ["worker start aec=0", "worker mic-closed"]);
});
