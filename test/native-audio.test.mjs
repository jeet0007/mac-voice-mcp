// The native backend behind the audio port (src/audio/native.ts), against the worker stub
// (test/stubs/audio-worker.mjs): VOICE_MCP_AUDIO=native, the stub installed as the built worker,
// and the Mac's speakers as the output (the system_profiler stub).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(path.join(os.tmpdir(), "voice-mcp-native-"));
const log = path.join(dir, "log.txt");
const cache = path.join(dir, "cache");
writeFileSync(log, "");
Object.assign(process.env, {
  STUB_LOG: log,
  STUB_SCENARIO: "silent",
  VOICE_MCP_AUDIO: "native",
  VOICE_MCP_CACHE_DIR: cache,
  VOICE_MCP_RECORDER: "sox",
  VOICE_MCP_VOICE: "",
  VOICE_MCP_EXTRA_PATH: "",
  VOICE_MCP_FLIGHT_RECORDER: "on",
  PATH: [path.join(ROOT, "test", "fixtures", "bin"), path.join(ROOT, "test", "fixtures", "installable"), path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
});
delete process.env.VOICE_MCP_CALL_DUPLEX;
delete process.env.VOICE_MCP_TTS;

/** The stub as the worker setup built: the binary, and the hash of the source it was built from. */
const bin = path.join(cache, "bin", "audio-worker");
mkdirSync(path.dirname(bin), { recursive: true });
symlinkSync(path.join(ROOT, "test", "stubs", "audio-worker.mjs"), bin);
const built = () => writeFileSync(`${bin}.hash`, createHash("sha256").update(readFileSync(path.join(ROOT, "native", "audio-worker.swift"))).digest("hex"));
built();

const { openAudio, play, MicBusyError } = await import("../dist/audio/device.js");
const { terminateChildren } = await import("../dist/proc.js");
after(() => terminateChildren()); // the standby `say` the process backend keeps for the next reply

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => l.replace(/ @\d+$/, ""));
const workerLines = () => lines().filter((l) => l.startsWith("worker "));
const fresh = (env = {}) => {
  writeFileSync(log, "");
  delete process.env.STUB_WORKER;
  Object.assign(process.env, env);
};
async function* tone(seconds) {
  yield Buffer.alloc(Math.round(seconds * 24000) * 2, 1);
}
const flight = () =>
  readdirSync(path.join(cache, "flight"))
    .filter((f) => f.startsWith("events-"))
    .flatMap((f) => readFileSync(path.join(cache, "flight", f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));

const darwin = { skip: (process.platform !== "darwin" || Number(os.release().split(".")[0]) < 24) && "the native backend needs macOS 15" };

test("a call on the Mac's speakers runs on the worker: interrupt duck, whole frames, echo until the canceller converges", darwin, async () => {
  fresh();
  const session = await openAudio({ purpose: "call" });
  assert.equal(session.interrupt, "duck");
  const frames = session.frames();
  const first = (await frames.next()).value;
  assert.equal(first.pcm.length, 960);
  assert.equal(first.echo, true, "just after the unit starts");
  for (let i = 0; i < 20; i++) assert.equal((await frames.next()).value.pcm.length, 960);
  await sleep(550);
  assert.equal((await frames.next()).value.echo, false, "converged after 500 ms");
  await session.close();
  assert.deepEqual(workerLines(), ["worker start aec=1", "worker mic-closed"]);
  assert.ok(!lines().some((l) => l.startsWith("rec ")), "no recorder ran");
  assert.equal((await frames.next()).done, true);
});

test("play, duck and stop become worker commands; done follows the stop's ack, and the position comes from the worker", darwin, async () => {
  fresh();
  const session = await openAudio({ purpose: "call" });
  const playback = play({ kind: "speech", chunks: tone(2) });
  await sleep(200);
  playback.duck(0.3);
  playback.duck(0.3);
  await sleep(100);
  playback.stop();
  playback.stop();
  assert.equal(await playback.done, "stopped");
  assert.ok(playback.playedMs() >= 150 && playback.playedMs() < 1000, `played ${playback.playedMs()} ms`);
  const cue = play({ kind: "cue", file: "/System/Library/Sounds/Tink.aiff", volume: 0.5 });
  assert.equal(await cue.done, "finished");
  await session.close();
  assert.deepEqual(workerLines(), [
    "worker start aec=1",
    "worker play 1 speech 24000",
    "worker end 1",
    "worker gain 1 0.3",
    "worker stop 1",
    "worker done 1 stopped",
    "worker play 2 cue /System/Library/Sounds/Tink.aiff",
    "worker done 2 finished",
    "worker mic-closed",
  ]);
});

test("the built-in voice: rendered by a `say -o` started ahead and played through the worker; after the call, `say` speaks directly", darwin, async () => {
  fresh();
  const session = await openAudio({ purpose: "call" });
  await sleep(300); // the standby `say` starts with the worker
  const text = "Sure, I can do that. The build finished without any errors, and every test passed.";
  assert.equal(await play({ kind: "voice", text }).done, "finished");
  await session.close();
  const log = lines();
  assert.ok(log.indexOf(log.find((l) => l.startsWith("tts-start"))) < log.indexOf(log.find((l) => l.startsWith("tts-input"))), "a say was waiting before the text came");
  assert.deepEqual(
    log.filter((l) => l.startsWith("speak")),
    ['speak-to-file "Sure, I can do that."', 'speak-to-file "The build finished without any errors,"', 'speak-to-file "and every test passed."'],
    "a chunk at a time, as Kokoro's are cut",
  );
  assert.deepEqual(workerLines().slice(1, 4), ["worker play 1 speech 24000", "worker end 1", "worker done 1 finished"]);

  fresh();
  assert.equal(await play({ kind: "voice", text: "Back on the speakers." }).done, "finished");
  assert.deepEqual(lines().filter((l) => l.startsWith("speak")), ['speak "Back on the speakers."']);
  assert.deepEqual(workerLines(), []);
});

test("while the worker runs, no process recorder starts; the worker starts only once the work listener's recorder has exited", darwin, async () => {
  fresh({ STUB_EXIT_DELAY_MS: "300" });
  const background = await openAudio({ purpose: "worklisten" });
  await background.frames().next();
  const call = await openAudio({ purpose: "call" });
  const log = lines();
  assert.ok(log.indexOf("rec exited") >= 0 && log.indexOf("rec exited") < log.indexOf("worker start aec=1"), log.join("\n"));
  const doctor = await openAudio({ purpose: "doctor" });
  assert.throws(() => doctor.frames(), MicBusyError);
  await doctor.close();
  await call.close();
  delete process.env.STUB_EXIT_DELAY_MS;
});

test("the worker missing or failing to start: the call falls back to the recorder, with a flight event", darwin, async () => {
  fresh();
  rmSync(`${bin}.hash`);
  let session = await openAudio({ purpose: "call" });
  assert.equal(session.interrupt, "none");
  await session.frames().next();
  await session.close();
  assert.deepEqual(workerLines(), [], "never asked for: setup didn't build it");
  assert.ok(lines().some((l) => l.startsWith("rec ")));
  built();

  fresh({ STUB_WORKER: "fail-start" });
  session = await openAudio({ purpose: "call" });
  assert.equal(session.interrupt, "none");
  await session.frames().next();
  await session.close();
  assert.deepEqual(workerLines(), ["worker start aec=1"]);
  const log = lines();
  assert.ok(log.indexOf("worker start aec=1") < log.findIndex((l) => l.startsWith("rec ")), "the recorder starts after the worker is gone");
  assert.equal(flight().filter((e) => e.ev === "audio.fallback").length, 1);
});

test("an output device change ends the session cleanly: playbacks done stopped, frames end with why", darwin, async () => {
  fresh({ STUB_WORKER: "route" });
  const session = await openAudio({ purpose: "call" });
  const playback = play({ kind: "speech", chunks: tone(5) });
  const frames = session.frames();
  await assert.rejects(async () => {
    for await (const _ of frames);
  }, { name: "WorkerLost", routeChanged: true, message: "The output device changed." });
  assert.equal(await playback.done, "stopped");
  await session.ended;
  assert.ok(session.signal.aborted);
  assert.equal(workerLines().at(-1), "worker mic-closed");
  fresh();
  const again = await openAudio({ purpose: "call" });
  assert.equal(again.interrupt, "duck", "a route change doesn't rule the worker out");
  await again.close();
});

test("the worker dying settles every playback and ends the session; later calls use the process backend", darwin, async () => {
  fresh({ STUB_WORKER: "dies" });
  const session = await openAudio({ purpose: "call" });
  const frames = session.frames();
  const playback = play({ kind: "speech", chunks: tone(5) });
  await assert.rejects(playback.done, { name: "WorkerLost", message: "The audio worker stopped (exit 1)." });
  await assert.rejects(async () => {
    for await (const _ of frames);
  }, { name: "WorkerLost", routeChanged: false });
  await session.ended;
  assert.ok(session.signal.aborted);
  assert.equal(flight().filter((e) => e.ev === "audio.lost").length, 2, "the route change, then this");

  fresh();
  const next = await openAudio({ purpose: "call" });
  assert.equal(next.interrupt, "none");
  await next.close();
  assert.deepEqual(workerLines(), []);
});
