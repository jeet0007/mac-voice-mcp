#!/usr/bin/env node
// Stub of the native audio worker (native/audio-worker.swift), speaking src/audio/protocol.ts:
// commands on stdin, mic frames on stdout, events on fd 3.
//
// Mic: the STUB_SCENARIO audio the `rec` stub plays (test/fixtures/scenarios.cjs), at the same 10x pace.
//   talk     noise; STUB_SPEECH_S (1.5) of speech each time the file $STUB_LOG.talk appears, which it removes
//   bargein  noise until a PCM sound has played STUB_BARGEIN_MS (500), then STUB_SPEECH_S of speech over it
// Playback: makes no sound. A sound's position advances in real time through the PCM it was sent;
//   a cue file lasts STUB_CUE_MS (100).
// STUB_WORKER: fail-start (an error event, exit 1) | dies (exit 1 after a second, no goodbye)
//   | route (the output device changes after a second: route-changed, mic-closed, exit 0)
// $STUB_LOG gets one line per thing a test may assert, each ending in " @<epoch ms>":
//   worker start aec=1 | play <id> speech <rate> | play <id> cue <file> | end <id> | gain <id> <value>
//   | pause <id> | resume <id> | stop <id> | done <id> finished|stopped | aec on|off | agc on|off
//   | duck-others <level> | speech-onset | mic-closed
import { appendFileSync, existsSync, rmSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import scenarios from "../fixtures/scenarios.cjs";
import { PROTOCOL_VERSION, parseCommand, serializeEvent } from "../../dist/audio/protocol.js";

const { STUB_LOG, STUB_WORKER, STUB_SCENARIO: scenario = "answer" } = process.env;
const log = (line) => void (STUB_LOG && appendFileSync(STUB_LOG, `worker ${line} @${Date.now()}\n`));
const emit = (event) => writeSync(3, serializeEvent(event));

const aec = !process.argv.includes("--no-aec");
log(`start aec=${aec ? 1 : 0}`);
if (STUB_WORKER === "fail-start") {
  emit({ ev: "error", stage: "start", code: -10875, message: "starting at 48000 Hz" });
  process.exit(1);
}
emit({ ev: "ready", v: PROTOCOL_VERSION, rate: 48000, aec });

/** id → { id, stream, rate, ms (audio received), played, lastPos, paused, ended, stopping } */
const sounds = new Map();
const playedMs = (sound) => Math.round(sound.played);

function finish(sound, reason) {
  sounds.delete(sound.id);
  log(`done ${sound.id} ${reason}`);
  emit({ ev: "done", id: sound.id, reason, playedMs: playedMs(sound) });
}

function close() {
  for (const sound of [...sounds.values()]) finish(sound, "stopped");
  log("mic-closed");
  emit({ ev: "mic-closed" });
  process.exit(0);
}
process.on("SIGTERM", close);
if (STUB_WORKER === "dies") setTimeout(() => process.exit(1), 1000);
if (STUB_WORKER === "route") {
  setTimeout(() => {
    emit({ ev: "route-changed", which: "output" });
    close();
  }, 1000);
}

// --- Mic ---
// Re-cut across the scenario's parts: the worker only ever writes whole frames.
const frames = scenarios.toFrames(scenarios.scenarioFrames(scenario).flat()).filter((f) => f.length === 480);
const userSpeaks = () => frames.push(...scenarios.toFrames(scenarios.speech(Number(process.env.STUB_SPEECH_S || 1.5))));
let next = 0;
process.stdout.on("error", () => {});
setInterval(() => {
  if (scenario === "talk" && STUB_LOG && existsSync(`${STUB_LOG}.talk`)) {
    rmSync(`${STUB_LOG}.talk`);
    userSpeaks();
  }
  process.stdout.write(scenarios.toPcm(next < frames.length ? frames[next++] : scenarios.tailFrame(scenario)));
}, 3);

// --- Playback ---
const bargeinMs = Number(process.env.STUB_BARGEIN_MS || 500);
let bargedIn = false;
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  for (const sound of [...sounds.values()]) {
    if (sound.stopping) {
      finish(sound, "stopped");
      continue;
    }
    if (!sound.paused) sound.played = Math.min(sound.ms, sound.played + now - last);
    if (scenario === "bargein" && !bargedIn && sound.stream && sound.played >= bargeinMs) {
      bargedIn = true;
      log("speech-onset");
      userSpeaks();
    }
    if (sound.ended && sound.played >= sound.ms) finish(sound, "finished");
    else if (sound.played - sound.lastPos >= 100) {
      sound.lastPos = sound.played;
      emit({ ev: "pos", id: sound.id, playedMs: playedMs(sound) });
    }
  }
  last = now;
}, 5);

/** Each returns an ack status other than "ok", or nothing. */
const handlers = {
  play(c) {
    if (sounds.has(c.id)) return "bad-command";
    const stream = "rate" in c;
    sounds.set(c.id, { id: c.id, stream, rate: c.rate, ms: stream ? 0 : Number(process.env.STUB_CUE_MS || 100), played: 0, lastPos: 0, paused: false, ended: !stream });
    log(stream ? `play ${c.id} speech ${c.rate}` : `play ${c.id} cue ${c.file}`);
  },
  pcm(c, sound) {
    if (!sound.stream || sound.ended) return "unknown-id";
    sound.ms += (Buffer.from(c.b64, "base64").length / 2 / sound.rate) * 1000;
  },
  end(c, sound) {
    if (!sound.stream || sound.ended) return "unknown-id";
    sound.ended = true;
    log(`end ${c.id}`);
  },
  gain: (c) => log(`gain ${c.id} ${c.value}`),
  pause(c, sound) {
    sound.paused = true;
    log(`pause ${c.id}`);
  },
  resume(c, sound) {
    sound.paused = false;
    log(`resume ${c.id}`);
  },
  stop(c, sound) {
    log(`stop ${c.id}`);
    // done follows the ack, at the next tick, as on the real worker
    sound.stopping = true;
  },
  aec: (c) => log(`aec ${c.on ? "on" : "off"}`),
  agc: (c) => log(`agc ${c.on ? "on" : "off"}`),
  "duck-others": (c) => log(`duck-others ${c.level}`),
};

function handle(line) {
  const c = parseCommand(line);
  if (!c) {
    let raw = null;
    try {
      raw = JSON.parse(line);
    } catch {}
    const readable = Number.isFinite(raw?.seq) && typeof raw.op === "string";
    return emit({ ev: "ack", seq: readable ? raw.seq : -1, op: readable ? raw.op : "", status: "bad-command" });
  }
  const sound = "id" in c ? sounds.get(c.id) : undefined;
  // A stopping sound takes only gain, as on the real worker.
  if ("id" in c && c.op !== "play" && (!sound || (sound.stopping && c.op !== "gain"))) return emit({ ev: "ack", seq: c.seq, op: c.op, status: "unknown-id" });
  const status = handlers[c.op](c, sound) ?? "ok";
  const named = sound ?? ("id" in c ? sounds.get(c.id) : undefined);
  emit({ ev: "ack", seq: c.seq, op: c.op, status, ...(status === "ok" && named && { playedMs: playedMs(named) }) });
}

createInterface({ input: process.stdin }).on("line", handle).on("close", close);
