#!/usr/bin/env node
// Probe for the call audio redesign (docs/specs/call-audio-redesign.md, migration step 1). Not shipped.
// Runs scripts/probe/aec-worker.swift against the real Endpointer and whisper-server and prints a
// pass/fail table plus a JSON report. See scripts/probe/README.md for the gates and their numbers.
//
//   node scripts/probe/probe.mjs --self-test     no human needed: protocol checks, a tone, clean exit
//   node scripts/probe/probe.mjs                 every gate; prompts you to stay quiet, then to talk
//   node scripts/probe/probe.mjs --no-human      gates d to h only
//   --only a,b  --skip f  --report FILE
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const buildDir = path.join(here, ".build");
const workerBin = path.join(buildDir, "aec-worker");
const workerSrc = path.join(here, "aec-worker.swift");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const list = (name) => (option(name) ?? "").split(",").filter(Boolean);
const SELF_TEST = flag("--self-test");
const HUMAN_GATES = ["a", "b", "c"];
const wanted = (gate) => {
  if (list("--only").length) return list("--only").includes(gate);
  if (list("--skip").includes(gate)) return false;
  return !(flag("--no-human") && HUMAN_GATES.includes(gate));
};

const ONSET_TO_DUCK_MAX_MS = 200;
const DUCK_GAIN = 0.3;
const CONVERGENCE_WINDOW_MS = 5000;
const PARTIAL_UNDER_FINAL_MAX_MS = 1000;
const SAY_PCM_SLACK_MS = 200;
const DUCK_SETTING_MIN_DB = 3;
const TRIALS = 3;
const MAX_ATTEMPTS = 6;
const BEEP_MS = 150;
// Nobody starts talking this soon after a beep: an onset earlier than this is echo or noise, not you.
const MIN_REACTION_MS = 150;

const rows = [];
const data = {};
function row(gate, check, verdict, detail) {
  rows.push({ gate, check, verdict, detail });
  console.log(`  [${verdict}] ${gate}: ${check}: ${detail}`);
}
const ms = (n) => `${Math.round(n)} ms`;
const db = (n) => `${n.toFixed(1)} dB`;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))];

function buildWorker() {
  mkdirSync(buildDir, { recursive: true });
  if (existsSync(workerBin) && statSync(workerBin).mtimeMs > statSync(workerSrc).mtimeMs) return;
  console.log("Building the worker (swiftc)…");
  const built = spawnSync("swiftc", ["-O", workerSrc, "-o", workerBin], { encoding: "utf8" });
  if (built.status !== 0) throw new Error(`swiftc failed:\n${built.stderr || built.error?.message}`);
}

async function loadDist() {
  if (!existsSync(path.join(root, "dist/endpointer.js"))) {
    console.log("Building dist (npm run build)…");
    const built = spawnSync("npm", ["run", "build"], { cwd: root, encoding: "utf8" });
    if (built.status !== 0) throw new Error(`npm run build failed:\n${built.stdout}${built.stderr}`);
  }
  const load = (name) => import(pathToFileURL(path.join(root, "dist", name)).href);
  const [endpointer, config, audio, stt, model] = await Promise.all(["endpointer.js", "config.js", "audio.js", "stt.js", "model.js"].map(load));
  return { ...endpointer, CONFIG: config.CONFIG, chooseVoice: audio.chooseVoice, stt, locateModel: model.locateModel };
}

/** Workers still running: a gate that throws leaves its worker here, and `guarded` closes it. */
const live = new Set();

/** Client for the worker: frames from stdout, events from fd 3, commands answered by acks. */
class Worker {
  frames = 0;
  bytes = 0;
  events = [];
  onFrame = null;
  #seq = 0;
  #acks = new Map();
  #waiters = new Set();

  constructor(args = []) {
    this.spawnedAt = performance.now();
    this.child = spawn(workerBin, args, { stdio: ["pipe", "pipe", "inherit", "pipe"] });
    this.child.stdin.on("error", () => {});
    this.exit = new Promise((resolve) => this.child.on("close", resolve));
    live.add(this);
    this.exit.then(() => live.delete(this));
    this.exit.then((code) => {
      for (const w of this.#waiters) w.reject(new Error(`the worker exited (${code}) while waiting for ${w.what}`));
    });
    let pending = Buffer.alloc(0);
    this.child.stdout.on("data", (chunk) => {
      this.bytes += chunk.length;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let off = 0;
      const now = performance.now();
      for (; pending.length - off >= this.FRAME_BYTES; off += this.FRAME_BYTES) {
        this.onFrame?.(Buffer.from(pending.subarray(off, off + this.FRAME_BYTES)), now, this.frames);
        this.frames++;
      }
      pending = pending.subarray(off);
    });
    let text = "";
    this.child.stdio[3].setEncoding("utf8").on("data", (d) => {
      text += d;
      const lines = text.split("\n");
      text = lines.pop();
      for (const line of lines) {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        event.t = performance.now();
        this.events.push(event);
        if (event.ev === "ack") this.#acks.get(event.seq)?.(event);
        for (const w of this.#waiters) if (w.match(event)) w.resolve(event);
      }
    });
  }
  FRAME_BYTES = 960;

  /** The first event (past or future) that matches. */
  wait(match, timeoutMs, what) {
    const seen = this.events.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const waiter = { match, what, resolve: (e) => (done(), resolve(e)), reject: (e) => (done(), reject(e)) };
      const timer = setTimeout(() => waiter.reject(new Error(`no ${what} within ${timeoutMs} ms`)), timeoutMs);
      const done = () => (clearTimeout(timer), this.#waiters.delete(waiter));
      this.#waiters.add(waiter);
    });
  }

  /** Send a command; resolves with its ack plus `ms`, the round trip as Node saw it. */
  cmd(command) {
    const seq = ++this.#seq;
    const sent = performance.now();
    this.child.stdin.write(`${JSON.stringify({ ...command, seq })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ack for ${command.op} within 3 s`)), 3000);
      this.#acks.set(seq, (ack) => {
        clearTimeout(timer);
        this.#acks.delete(seq);
        resolve({ ...ack, ms: ack.t - sent });
      });
    });
  }

  async play(id, pcm, rate, gain = 1) {
    await this.cmd({ op: "play", id, rate, gain });
    for (let off = 0; off < pcm.length; off += rate) await this.cmd({ op: "pcm", id, b64: pcm.subarray(off, off + rate).toString("base64") });
    await this.cmd({ op: "end", id });
  }

  lastPos(id) {
    return this.events.findLast((e) => e.ev === "pos" && e.id === id)?.ms ?? 0;
  }

  async close() {
    this.child.stdin.end();
    const code = await Promise.race([this.exit, sleep(3000).then(() => (this.child.kill("SIGKILL"), "killed"))]);
    return { micClosed: this.events.some((e) => e.ev === "mic-closed"), code };
  }
}

async function startWorker(args = []) {
  const w = new Worker(args);
  try {
    const ready = await w.wait((e) => e.ev === "ready" || e.ev === "error", 10_000, "ready");
    if (ready.ev === "error") throw new Error(`the worker could not start: ${ready.message} (stage ${ready.stage}, status ${ready.status})`);
    return { w, ready };
  } catch (err) {
    w.child.kill("SIGKILL");
    throw err;
  }
}

function tonePcm(hz, durationMs, rate, amplitude) {
  const n = Math.round((rate * durationMs) / 1000);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const edge = Math.min(1, i / 240, (n - i) / 240); // 10 ms fades at 24 kHz: no clicks
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * amplitude * edge * 32767), i * 2);
  }
  return pcm;
}

function frameDb(frame) {
  let sum = 0;
  for (let i = 0; i + 1 < frame.length; i += 2) sum += (frame.readInt16LE(i) / 32768) ** 2;
  return 10 * Math.log10(sum / (frame.length / 2) + 1e-12);
}

function wavData(wav) {
  for (let off = 12; off + 8 <= wav.length; ) {
    const size = wav.readUInt32LE(off + 4);
    if (wav.toString("ascii", off, off + 4) === "data") return wav.subarray(off + 8, off + 8 + Math.min(size, wav.length - off - 8));
    off += 8 + size + (size % 2);
  }
  return Buffer.alloc(0);
}

/**
 * The call's frame loop (listenContinuously) around the real Endpointer: a fresh one per utterance.
 * Every time speech begins is an onset: in the redesign each one would duck the reply.
 */
function makeEar(dist) {
  const fresh = () =>
    new dist.Endpointer({
      maxMs: 60_000,
      startTimeoutMs: 60_000,
      endSilenceMs: dist.CONFIG.endSilenceMs,
      marginDb: dist.CONFIG.speechMarginDb,
      minSpeechDb: dist.CONFIG.minSpeechDb,
    });
  const ear = {
    onsets: [],
    levels: [],
    nonZero: false,
    onOnset: null,
    endpointer: fresh(),
    base: 0,
    arrivals: [],
    speaking: false,
    push(frame, t, index) {
      ear.arrivals[index] = t;
      const reason = ear.endpointer.push(frame);
      ear.nonZero ||= ear.endpointer.anyNonZero;
      const level = { t, db: ear.endpointer.lastDb, thresholdDb: ear.endpointer.lastThresholdDb };
      ear.levels.push(level);
      if (ear.endpointer.speaking && !ear.speaking) {
        const onset = { t, firstVoicedT: ear.arrivals[ear.base + ear.endpointer.speechStartFrame] ?? t };
        ear.onsets.push(onset);
        ear.onOnset?.(onset);
      }
      ear.speaking = ear.endpointer.speaking;
      if (reason) ear.reset(index + 1);
    },
    reset(nextIndex) {
      ear.endpointer = fresh();
      ear.base = nextIndex;
      ear.speaking = false;
    },
  };
  return ear;
}

function listen(w, dist) {
  const ear = makeEar(dist);
  ear.base = w.frames;
  w.onFrame = ear.push;
  return ear;
}

const nextOnset = (ear, timeoutMs) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => ((ear.onOnset = null), resolve(null)), timeoutMs);
    ear.onOnset = (onset) => (clearTimeout(timer), (ear.onOnset = null), resolve(onset));
  });

/** Beep through the worker (so it is echo-cancelled) with the ear not judging it, the way a call ignores its own chime. */
async function beepCue(w, ear, id, timeoutMs) {
  ear.reset(w.frames);
  ear.endpointer.setIgnoring(true);
  const onset = nextOnset(ear, timeoutMs);
  await w.play(id, tonePcm(1500, BEEP_MS, 24000, 0.5), 24000);
  const cueT = performance.now();
  const heard = sleep(BEEP_MS + 60).then(() => (ear.endpointer.setIgnoring(false), onset));
  return { cueT, heard };
}

const levelsBetween = (ear, from, to) => ear.levels.filter((l) => l.t >= from && l.t < to).map((l) => l.db);
const summary = (levels) => (levels.length ? { p50: percentile(levels, 50), p95: percentile(levels, 95), max: Math.max(...levels) } : null);

async function countdown(message, seconds = 3, end = "now.") {
  console.log(`\n>>> ${message}`);
  for (let s = seconds; s > 0; s--) {
    process.stdout.write(`    ${s}… `);
    await sleep(1000);
  }
  console.log(end);
}

async function sayArgs(dist) {
  const { voice } = await dist.chooseVoice();
  return [...(voice ? ["-v", voice] : []), ...(dist.CONFIG.rate ? ["-r", dist.CONFIG.rate] : [])];
}
const pcmFormat = (rate) => ["--file-format=WAVE", `--data-format=LEI16@${rate}`];

async function sayToPcm(dist, text, rate, tmp) {
  const file = path.join(tmp, `say-${rate}-${text.length}.wav`);
  const said = spawnSync("say", [...(await sayArgs(dist)), "-o", file, ...pcmFormat(rate), text], { encoding: "utf8" });
  if (said.status !== 0) throw new Error(`say -o failed: ${said.stderr}`);
  return wavData(readFileSync(file));
}

const REPLY =
  "This is the echo test. I am going to keep talking for a while, so the probe can measure how much of my own voice comes back through the microphone. " +
  "Nothing here needs an answer. I looked at the build, and it finished without any errors. The tests ran next, and all of them passed on the first try. " +
  "After that I read through the three files you mentioned, and I think the change is smaller than it first looked. " +
  "There is one function that does most of the work, and two places that call it. I will describe both, and then say what I would change.";

// --- Self-test: no human, no speech ---------------------------------------------------------------
async function selfTest(dist) {
  const { w, ready } = await startWorker();
  row("self", "worker starts", "PASS", `voice-processing unit at ${ready.rate} Hz, echo cancellation ${ready.aec ? "on" : "off"}, ready ${ms(ready.t - w.spawnedAt)} after spawn`);

  const arrivals = [];
  w.onFrame = (_frame, t) => arrivals.push(t);
  await sleep(1500);
  const perSecond = arrivals.length / ((arrivals.at(-1) - arrivals[0]) / 1000 || 1);
  row("self", "mic frames stream", arrivals.length >= 40 && Math.abs(perSecond - 1000 / 30) < 3 ? "PASS" : "FAIL", `${arrivals.length} frames of 960 bytes in 1.5 s (${perSecond.toFixed(1)} per second, 33.3 expected)`);

  await w.play(1, tonePcm(440, 1500, 24000, 0.1), 24000);
  const done = await w.wait((e) => e.ev === "done" && e.id === 1, 5000, "done for the tone");
  const positions = w.events.filter((e) => e.ev === "pos" && e.id === 1).map((e) => e.ms);
  const rising = positions.every((p, i) => i === 0 || p >= positions[i - 1]);
  row("self", "plays a PCM stream", done.end === "finished" && Math.abs(done.ms - 1500) <= 30 && positions.length >= 8 && rising ? "PASS" : "FAIL", `1500 ms tone at 24 kHz: done "${done.end}" at ${done.ms} ms, ${positions.length} position events`);

  await w.play(2, tonePcm(440, 4000, 24000, 0.1), 24000);
  await sleep(300);
  const gain = await w.cmd({ op: "gain", id: 2, value: DUCK_GAIN, rampMs: 10 });
  row("self", "gain is acknowledged", gain.status === 0 && gain.ms < 50 ? "PASS" : "FAIL", `status ${gain.status}, ${gain.ms.toFixed(1)} ms from command to ack`);

  await w.cmd({ op: "pause", id: 2 });
  await sleep(250);
  const pausedAt = w.lastPos(2);
  await sleep(400);
  const stillAt = w.lastPos(2);
  await w.cmd({ op: "resume", id: 2 });
  await sleep(350);
  const resumedAt = w.lastPos(2);
  row("self", "pause holds the position, resume continues", stillAt === pausedAt && resumedAt > stillAt ? "PASS" : "FAIL", `paused at ${pausedAt} ms, ${stillAt} ms after 400 ms, ${resumedAt} ms after resume`);

  await w.cmd({ op: "stop", id: 2 });
  const stopped = await w.wait((e) => e.ev === "done" && e.id === 2, 1000, "done for the stopped tone");
  row("self", "stop ends the sound", stopped.end === "stopped" ? "PASS" : "FAIL", `done "${stopped.end}" at ${stopped.ms} ms of 4000`);

  w.child.stdin.write("this is not json\n");
  const unknown = await w.cmd({ op: "gain", id: 99, value: 1 });
  row("self", "bad input is refused, not fatal", unknown.status === -1 ? "PASS" : "FAIL", `a malformed line was dropped; a gain for an unknown sound got status ${unknown.status}`);

  const ear = listen(w, dist);
  await sleep(1000);
  if (ear.onsets.length) row("a", "the beep cue is not an onset", "SKIP", "the room was not quiet before the beep");
  else {
    const cue = await beepCue(w, ear, 4, 1500);
    const onset = await cue.heard;
    row("a", "the beep cue is not an onset", onset ? "FAIL" : "PASS", onset ? `the ear took gate a's own beep for a voice ${ms(onset.firstVoicedT - cue.cueT)} after it started` : "gate a's beep played with echo cancellation on, and no onset in the 1.5 s after it");
  }
  w.onFrame = null;

  const aecOff = await w.cmd({ op: "aec", on: false });
  const agc = await w.cmd({ op: "agc", on: false });
  const duck = await w.cmd({ op: "duck-others", level: "min", advanced: false });
  row("self", "settings apply while running", aecOff.status === 0 ? "PASS" : "FAIL", `echo cancellation off: status ${aecOff.status}; gain control off: status ${agc.status}; other-audio ducking "min": status ${duck.status}`);

  await loopbackDuck(w, dist);

  const closed = await w.close();
  row("self", "stops cleanly on stdin EOF", closed.micClosed && closed.code === 0 && w.bytes % 960 === 0 ? "PASS" : "FAIL", `mic-closed ${closed.micClosed ? "sent" : "missing"}, exit ${closed.code}, ${w.bytes} mic bytes in whole frames`);
}

/**
 * Gate (a) without a person: with echo cancellation off, a tone we play is "someone talking" to the
 * mic. Same path as the real thing: worker frames, Endpointer onset in Node, gain command, ack.
 */
async function loopbackDuck(w, dist) {
  const ear = listen(w, dist);
  await sleep(1200);
  if (ear.onsets.length) return row("a", "onset to duck, tone loopback", "SKIP", "the room was not quiet before the tone, so the onset can't be attributed");
  const started = performance.now();
  // Loud on purpose: a laptop mic hears its own speakers about 40 dB down, and speech needs -48 dB.
  void w.play(3, tonePcm(1000, 1500, 24000, 0.8), 24000);
  const onset = await nextOnset(ear, 2500);
  if (!onset) {
    await w.cmd({ op: "stop", id: 3 }).catch(() => {});
    return row("a", "onset to duck, tone loopback", "SKIP", "the mic never heard the tone (speakers muted, very low, or headphones)");
  }
  const ack = await w.cmd({ op: "gain", id: 3, value: DUCK_GAIN, rampMs: 10 });
  if (ack.status !== 0) return row("a", "onset to duck, tone loopback", "FAIL", `the tone had already ended when the onset came (gain status ${ack.status})`);
  const latency = ack.t - onset.firstVoicedT;
  data.loopbackDuck = { firstVoicedToAckMs: latency, onsetDecisionToAckMs: ack.ms, playToFirstVoicedMs: onset.firstVoicedT - started };
  row("a", "onset to duck, tone loopback", latency < ONSET_TO_DUCK_MAX_MS ? "PASS" : "FAIL", `${ms(latency)} from the first voiced frame reaching Node to the gain ack (gate under ${ONSET_TO_DUCK_MAX_MS}); ${ack.ms.toFixed(1)} ms of that is command to ack, the rest is the Endpointer's 120 ms onset rule`);
  await w.cmd({ op: "stop", id: 3 }).catch(() => {});
  w.onFrame = null;
}

// --- (g) Bluetooth and (h) mic permission ------------------------------------------------------------
async function gateDevices(dist) {
  let session;
  try {
    session = await startWorker();
  } catch (err) {
    if (wanted("h")) row("h", "mic access from Node", "FAIL", err.message);
    if (wanted("g")) row("g", "Bluetooth", "SKIP", "the worker did not start");
    return;
  }
  const { w, ready } = session;
  const before = await w.wait((e) => e.ev === "devices" && e.when === "before", 2000, "devices");
  const ear = listen(w, dist);
  await sleep(1500);
  let heard = ear.nonZero;
  if (!heard) {
    await w.cmd({ op: "aec", on: false }); // noise suppression can hand back exact zeros in a silent room
    await sleep(1000);
    heard = ear.nonZero;
  }
  const after = (await w.cmd({ op: "info" }), w.events.findLast((e) => e.ev === "devices"));
  await w.close();
  data.devices = { before, after, unitRate: ready.rate };
  data.route = `${after.output.name} (${after.output.transport}) / mic ${after.input.name} (${after.input.transport})`;
  if (wanted("h")) row("h", "mic access from Node", heard ? "PASS" : "FAIL", `permission "${ready.micAuth}", ${ear.levels.length} frames, ${heard ? "real audio (not all zeros)" : "ALL ZEROS: the mic is blocked for the app that started Node"}`);
  if (!wanted("g")) return;
  const rates = `output ${before.output.rate} → ${after.output.rate} Hz, input ${before.input.rate} → ${after.input.rate} Hz`;
  if (!after.output.bluetooth && !after.input.bluetooth) return row("g", "Bluetooth", "SKIP", `route is ${data.route}, not Bluetooth; ${rates}. Connect a Bluetooth headset and rerun with --only g`);
  const dropped = after.output.rate < before.output.rate;
  row("g", "Bluetooth", "INFO", `route is ${data.route}; ${rates}. ${dropped ? "The output rate dropped: the headset switched to its call (HFP) profile, so music quality drops too" : "The output rate did not change"}`);
}

// --- (b) convergence, (c) residue, (a) onset to duck: one session with a person ----------------------
async function humanSession(dist, tmp) {
  const reply = await sayToPcm(dist, REPLY, 24000, tmp);
  const replyMs = reply.length / 2 / 24;
  if (wanted("b") || wanted("c")) {
    await countdown(`STAY QUIET for about ${Math.round(replyMs / 1000) + 8} seconds. It will talk; don't talk, type or move. Speakers on, normal volume.`);
    const { w } = await startWorker();
    const ear = listen(w, dist);
    const playAck = await w.cmd({ op: "play", id: 1, rate: 24000 }); // straight away: no calibration, like a call's greeting
    const t0 = playAck.t;
    void (async () => {
      for (let off = 0; off < reply.length; off += 24000) await w.cmd({ op: "pcm", id: 1, b64: reply.subarray(off, off + 24000).toString("base64") });
      await w.cmd({ op: "end", id: 1 });
    })();
    const bypassAt = Math.max(CONVERGENCE_WINDOW_MS + 5000, replyMs - 4000);
    await sleep(bypassAt);
    const tBypass = (await w.cmd({ op: "aec", on: false })).t;
    await w.wait((e) => e.ev === "done" && e.id === 1, 30_000, "the reply to finish");
    const tDone = performance.now();
    await w.cmd({ op: "aec", on: true });
    await sleep(2000);
    const tEnd = performance.now();
    w.onFrame = null;
    await w.close();

    const early = ear.onsets.filter((o) => o.t - t0 < CONVERGENCE_WINDOW_MS);
    const late = ear.onsets.filter((o) => o.t - t0 >= CONVERGENCE_WINDOW_MS && o.t < tBypass);
    const lastLoud = ear.levels.findLast((l) => l.t >= t0 && l.t - t0 < CONVERGENCE_WINDOW_MS && l.db > l.thresholdDb);
    const residue = summary(levelsBetween(ear, t0 + CONVERGENCE_WINDOW_MS, tBypass));
    const raw = summary(levelsBetween(ear, tBypass + 500, tDone));
    const floor = summary(levelsBetween(ear, tDone + 700, tEnd));
    data.echo = { route: data.route, falseOnsetsFirst5s: early.map((o) => o.t - t0), convergedAfterMs: lastLoud ? lastLoud.t - t0 : 0, falseOnsetsLater: late.map((o) => o.t - t0), residueDb: residue, uncancelledDb: raw, roomDb: floor, minSpeechDb: dist.CONFIG.minSpeechDb };
    if (wanted("b")) row("b", "no self-interruption at the start", early.length === 0 ? "PASS" : "FAIL", `${early.length} false onsets in the first 5 s of playback with no calibration${early.length ? ` (at ${early.map((o) => ms(o.t - t0)).join(", ")})` : ""}; last frame over the speech threshold at ${ms(data.echo.convergedAfterMs)}`);
    if (wanted("c")) row("c", `echo residue on ${data.route ?? "this route"}`, late.length === 0 ? "PASS" : "FAIL", `${late.length} false onsets over ${ms(tBypass - t0 - CONVERGENCE_WINDOW_MS)} of reply; residue median ${db(residue.p50)}, 95th ${db(residue.p95)}, max ${db(residue.max)}; uncancelled ${raw ? db(raw.p50) : "n/a"}; room ${floor ? db(floor.p50) : "n/a"}; speech needs ${dist.CONFIG.minSpeechDb} dB`);
  }
  if (!wanted("a")) return;

  console.log(`\n>>> Next: it talks again. After each countdown it BEEPS: start talking over it right then ("wait, hold on a second").`);
  const { w } = await startWorker();
  const ear = listen(w, dist);
  await w.play(2, Buffer.concat([reply, reply, reply]), 24000);
  const latencies = [];
  const reactions = [];
  const missed = [];
  let falseOnsets = 0;
  let attempts = 0;
  while (latencies.length < TRIALS && attempts < MAX_ATTEMPTS) {
    attempts++;
    const quietFrom = ear.onsets.length;
    await countdown(`Trial ${latencies.length + 1} of ${TRIALS} (attempt ${attempts} of ${MAX_ATTEMPTS}): talk at the beep`, 3, "");
    falseOnsets += ear.onsets.length - quietFrom; // it "heard" something while you were still waiting
    const { cueT, heard } = await beepCue(w, ear, 10 + attempts, 6000);
    console.log("    >>> NOW: TALK <<<");
    const onset = await heard;
    if (!onset) {
      missed.push("no voice");
      console.log("    No attempt: heard no voice within 6 s of the beep. Retrying.");
      continue;
    }
    const reaction = onset.firstVoicedT - cueT;
    if (reaction < MIN_REACTION_MS) {
      missed.push(`onset ${ms(reaction)} after the beep`);
      console.log(`    No attempt: something was heard ${ms(reaction)} after the beep, too soon to be you (echo or noise). Retrying.`);
      await sleep(2500);
      continue;
    }
    const ack = await w.cmd({ op: "gain", id: 2, value: DUCK_GAIN, rampMs: 10 });
    if (ack.status !== 0) throw new Error(`the reply was not playing when it heard you (gain status ${ack.status})`);
    latencies.push(ack.t - onset.firstVoicedT);
    reactions.push(reaction);
    console.log(`    ducked ${ms(ack.t - onset.firstVoicedT)} after your first sound reached Node (you started ${ms(reaction)} after the beep). Stop talking now.`);
    await sleep(2500);
    await w.cmd({ op: "gain", id: 2, value: 1, rampMs: 50 });
  }
  w.onFrame = null;
  await w.cmd({ op: "stop", id: 2 }).catch(() => {});
  await w.close();
  data.onsetToDuck = { latenciesMs: latencies, reactionMs: reactions, attempts, missed, onsetsBeforeTheCue: falseOnsets };
  const heardOf = `heard ${latencies.length} of ${attempts} attempts${missed.length ? ` (missed: ${missed.join("; ")})` : ""}`;
  if (latencies.length < TRIALS) return row("a", "onset to duck, your voice", "FAIL", `${heardOf}; ${TRIALS} needed. If you did talk at every beep, echo cancellation may be removing your voice too`);
  row("a", "onset to duck, your voice", Math.max(...latencies) < ONSET_TO_DUCK_MAX_MS ? "PASS" : "FAIL", `${latencies.map(ms).join(", ")} from the first voiced frame reaching Node to the gain ack (gate under ${ONSET_TO_DUCK_MAX_MS}); ${heardOf}; ${falseOnsets} onsets during the countdowns`);
}

// --- (d) whisper-server: a partial while a final runs ------------------------------------------------
async function gateWhisper(dist, tmp) {
  const model = await dist.locateModel();
  if (!model || !dist.stt.findWhisperServer()) return row("d", "partial while a final runs", "SKIP", !model ? "no whisper model on this machine (run voice_setup)" : "whisper-server is not installed");
  const header = (pcm) => Buffer.concat([dist.wavHeader(pcm.length), pcm]);
  const long = header(await sayToPcm(dist, REPLY, 16000, tmp));
  const short = header((await sayToPcm(dist, "Wait, hold on a second.", 16000, tmp)));
  const never = new AbortController().signal;
  dist.stt.prewarm(model);
  const timed = async (run) => {
    const t = performance.now();
    const text = await run();
    return { ms: performance.now() - t, ok: typeof text === "string" && text.length > 0 };
  };
  const final = () => timed(() => dist.stt.transcribeBuffer(long, model));
  const partial = () => timed(() => dist.stt.transcribePartial(short, never));
  try {
    await final(); // the first request also waits for the model to load
    const alone = { final: [], partial: [] };
    const together = { final: [], partial: [] };
    let partialFailed = 0;
    for (let i = 0; i < 3; i++) {
      alone.final.push((await final()).ms);
      alone.partial.push((await partial()).ms);
      const running = final();
      await sleep(50);
      const p = await partial();
      if (!p.ok) partialFailed++;
      together.partial.push(p.ms);
      together.final.push((await running).ms);
    }
    const m = { finalAlone: median(alone.final), partialAlone: median(alone.partial), finalTogether: median(together.final), partialTogether: median(together.partial) };
    const serial = m.partialTogether > m.partialAlone + 0.5 * m.finalAlone;
    data.whisper = { model: path.basename(model), longAudioMs: (long.length - 44) / 32, shortAudioMs: (short.length - 44) / 32, ...m, runs: { alone, together }, partialFailed, oneAtATime: serial };
    const verdict = partialFailed === 0 && m.partialTogether < PARTIAL_UNDER_FINAL_MAX_MS ? "PASS" : "FAIL";
    row("d", "partial while a final runs", verdict, `${path.basename(model)}: partial ${ms(m.partialAlone)} alone, ${ms(m.partialTogether)} while a final runs (gate under ${PARTIAL_UNDER_FINAL_MAX_MS}); final ${ms(m.finalAlone)} alone, ${ms(m.finalTogether)} with a partial; ${partialFailed} of 3 partials failed. The server ${serial ? "runs ONE request at a time: the partial waited for the final" : "ran both at once"}`);
  } finally {
    dist.stt.stopWhisperServer();
  }
}

// --- (e) first sentence: `say -o` to PCM through the worker, against the standby `say` ---------------
async function gateSay(dist, tmp) {
  const sentence = "The build finished without any errors.";
  const voice = await sayArgs(dist);
  const { w } = await startWorker(["--no-aec"]); // the mic is the stopwatch here: it must hear the speakers
  await w.cmd({ op: "duck-others", level: "min", advanced: false }); // the unit would otherwise duck the standby `say`, which is another app
  const levels = [];
  w.onFrame = (frame, t) => levels.push({ t, db: frameDb(frame) });
  const closeOf = (child) => new Promise((resolve) => child.on("close", resolve));

  /**
   * Milliseconds from start() until the mic hears sound (three frames 8 dB over the room), or null.
   * Not the Endpointer: this is a stopwatch, and speakers reach a laptop mic below the speech threshold.
   */
  const untilHeard = async (start) => {
    const t0 = performance.now();
    const loud = median(levels.filter((l) => l.t > t0 - 1000).map((l) => l.db)) + 8;
    const stop = await start();
    let heard = null;
    while (heard === null && performance.now() - t0 < 6000) {
      await sleep(30);
      const since = levels.filter((l) => l.t >= t0);
      const i = since.findIndex((l, j) => j >= 2 && l.db > loud && since[j - 1].db > loud && since[j - 2].db > loud);
      if (i >= 0) heard = since[i - 2].t - t0;
    }
    await stop();
    return heard;
  };
  const speakers = (standby) => async () => {
    const child = spawn("say", [...voice, "-f", "-"], { stdio: ["pipe", "ignore", "ignore"] });
    if (standby) await sleep(2000);
    return { child };
  };
  let id = 100;
  const throughWorker = (standby) => async () => {
    const file = path.join(tmp, `first-${++id}.wav`);
    const child = spawn("say", [...voice, "-o", file, ...pcmFormat(24000), "-f", "-"], { stdio: ["pipe", "ignore", "ignore"] });
    if (standby) await sleep(2000);
    return { child, file };
  };
  const measure = async (prepare, standby, viaWorker) => {
    const times = [];
    const synth = [];
    for (let i = 0; i < 3; i++) {
      await sleep(1200); // quiet between tries
      const waiting = standby ? await prepare() : null;
      const heard = await untilHeard(async () => {
        const { child, file } = waiting ?? (await prepare()); // cold: starting `say` is on the clock
        const t = performance.now();
        child.stdin.end(sentence);
        if (!viaWorker) return () => (child.kill(), closeOf(child));
        await closeOf(child);
        synth.push(performance.now() - t);
        const soundId = id;
        void w.play(soundId, wavData(readFileSync(file)), 24000);
        return () => w.cmd({ op: "stop", id: soundId });
      });
      if (heard !== null) times.push(heard);
    }
    return { heardMs: times.length ? median(times) : null, synthMs: synth.length ? median(synth) : null, runs: times };
  };
  try {
    const result = {
      standbySay: await measure(speakers(true), true, false),
      coldSay: await measure(speakers(false), false, false),
      coldSayToPcm: await measure(throughWorker(false), false, true),
      standbySayToPcm: await measure(throughWorker(true), true, true),
    };
    data.firstSentence = { sentence, voice: voice.join(" ") || "system voice", ...result };
    const pcmBest = [result.coldSayToPcm.heardMs, result.standbySayToPcm.heardMs].filter((x) => x !== null);
    if (result.standbySay.heardMs === null || !pcmBest.length) return row("e", "first sentence: say -o against standby say", "SKIP", `the mic did not hear the speakers (muted or headphones). Time to make the PCM: ${ms(result.coldSayToPcm.synthMs ?? NaN)} cold, ${ms(result.standbySayToPcm.synthMs ?? NaN)} standby`);
    const show = (r) => (r.heardMs === null ? "not heard" : ms(r.heardMs));
    row("e", "first sentence: say -o against standby say", Math.min(...pcmBest) <= result.standbySay.heardMs + SAY_PCM_SLACK_MS ? "PASS" : "FAIL", `text to first sound at the mic: standby say ${show(result.standbySay)}, cold say ${show(result.coldSay)}, say -o + worker ${show(result.coldSayToPcm)} cold (PCM ready in ${ms(result.coldSayToPcm.synthMs)}), ${show(result.standbySayToPcm)} with a standby say -o (PCM in ${ms(result.standbySayToPcm.synthMs)}). Gate: best PCM path within ${SAY_PCM_SLACK_MS} ms of standby say`);
  } finally {
    w.onFrame = null;
    await w.close();
  }
}

// --- (f) other apps' audio while the unit runs --------------------------------------------------------
function toneLevelDb(pcm, hz) {
  // Goertzel: the level of one frequency, so room noise doesn't count.
  const n = pcm.length >> 1;
  if (n < 1600) return -120;
  const k = 2 * Math.cos((2 * Math.PI * hz) / 16000);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = pcm.readInt16LE(i * 2) / 32768 + k * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - k * s1 * s2;
  return 10 * Math.log10(Math.max((power * 4) / (n * n), 1e-12));
}

async function gateDucking(dist, tmp) {
  const toneFile = path.join(tmp, "other-app.wav");
  const tone = tonePcm(1000, 40_000, 16000, 0.1);
  writeFileSync(toneFile, Buffer.concat([dist.wavHeader(tone.length), tone]));

  // The unit's own mic with processing bypassed is the meter: with it on, other apps' sound is cancelled too.
  const { w } = await startWorker();
  let heard = [];
  w.onFrame = (frame) => heard.push(frame);
  const measure = async (settleMs) => {
    await sleep(settleMs);
    heard = [];
    await sleep(1500);
    return toneLevelDb(Buffer.concat(heard), 1000);
  };
  let other;
  try {
    await w.cmd({ op: "aec", on: false });
    const room = await measure(500);
    void w.play(1, tonePcm(1000, 2500, 24000, 0.1), 24000);
    const own = await measure(500);
    if (own < room + 10) return row("f", "other apps' audio", "SKIP", `the mic could not hear a test tone from the speakers (${db(own)} against ${db(room)} of room): muted, very low, or headphones`);
    await sleep(800);
    other = spawn("afplay", [toneFile], { stdio: "ignore" }); // "another app": a different process playing the same tone at the same level
    const ducked = {};
    const statuses = {};
    // A change of level takes a second or two to fade in, so wait before measuring.
    for (const [name, level, advanced] of [["default", "default", false], ["min", "min", false], ["advanced+min with nobody talking", "min", true], ["mid", "mid", false], ["max", "max", false], ["min again", "min", false]]) {
      statuses[name] = (await w.cmd({ op: "duck-others", level, advanced })).status;
      ducked[name] = own - (await measure(2500));
    }
    data.ducking = { ownToneDb: own, roomDb: room, otherAppQuieterThanOwnByDb: ducked, setStatus: statuses };
    // "min again" after "max": a level that only drifts with time would otherwise pass min, then max.
    const works = statuses.min === 0 && statuses.max === 0 && ducked.max - Math.max(ducked.min, ducked["min again"]) >= DUCK_SETTING_MIN_DB;
    const shown = Object.entries(ducked).map(([name, d]) => `${name} ${d.toFixed(1)}`).join("; ");
    row("f", "other apps' audio", works ? "PASS" : "FAIL", `another app's tone is quieter than the same tone played by the unit by (dB): ${shown}. Set status min ${statuses.min}, max ${statuses.max}. Gate: the setting is accepted and "max" ducks at least ${DUCK_SETTING_MIN_DB} dB more than "min", before and after it`);
  } finally {
    other?.kill();
    w.onFrame = null;
    await w.close();
  }
  const rec = spawnSync("which", ["rec"], { encoding: "utf8" }).stdout.trim();
  if (rec) await secondRecorder(rec);
}

/** What a `rec` that was already recording gets once the unit starts: bytes per second before, during and after. */
async function secondRecorder(rec) {
  let bytes = 0;
  const recorder = spawn(rec, ["-q", "-V1", "-t", "raw", "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", "-"], { stdio: ["ignore", "pipe", "ignore"] });
  recorder.stdout.on("data", (c) => (bytes += c.length));
  const rate = async () => {
    await sleep(1000);
    const from = bytes;
    await sleep(2000);
    return (bytes - from) / 2;
  };
  let w;
  try {
    const before = await rate();
    ({ w } = await startWorker());
    const during = await rate();
    await w.close();
    w = null;
    const after = await rate();
    data.secondRecorder = { bytesPerSecond: { before, during, after } };
    row("f", "a recorder that was already running", "INFO", `rec (16 kHz is 32000 bytes per second) gave ${Math.round(before)} bytes per second before the unit started, ${Math.round(during)} while it ran, ${Math.round(after)} after${during > before * 1.5 ? ". Its audio arrives at the wrong rate while the unit runs" : ""}`);
  } finally {
    recorder.kill();
    await w?.close();
  }
}

// --- Run ----------------------------------------------------------------------------------------
const tmp = mkdtempSync(path.join(os.tmpdir(), "aec-probe-"));
let crashed = null;
try {
  buildWorker();
  const dist = await loadDist();
  const guarded = async (gate, name, run) => {
    try {
      await run();
    } catch (err) {
      row(gate, name, "FAIL", err.message);
    } finally {
      await Promise.all([...live].map((w) => w.close()));
    }
  };
  console.log(SELF_TEST ? "Self-test (no human needed; plays two short tones)" : "Call audio probe");
  if (SELF_TEST) {
    await guarded("self", "self-test", () => selfTest(dist));
    await guarded("g/h", "devices", () => gateDevices(dist));
  } else {
    if (wanted("g") || wanted("h") || wanted("c")) await guarded("g/h", "devices", () => gateDevices(dist));
    if (HUMAN_GATES.some(wanted)) await guarded("a/b/c", "session with a person", () => humanSession(dist, tmp));
    if (wanted("d")) await guarded("d", "partial while a final runs", () => gateWhisper(dist, tmp));
    if (wanted("e")) await guarded("e", "first sentence", () => gateSay(dist, tmp));
    if (wanted("f")) await guarded("f", "other apps' audio", () => gateDucking(dist, tmp));
  }
} catch (err) {
  crashed = err;
  row("probe", "setup", "FAIL", err.message);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const width = { gate: Math.max(4, ...rows.map((r) => r.gate.length)), check: Math.max(5, ...rows.map((r) => r.check.length)) };
console.log(`\n${"GATE".padEnd(width.gate)}  ${"CHECK".padEnd(width.check)}  RESULT`);
for (const r of rows) console.log(`${r.gate.padEnd(width.gate)}  ${r.check.padEnd(width.check)}  ${r.verdict}`);
const failed = rows.filter((r) => r.verdict === "FAIL").length;
const skipped = rows.filter((r) => r.verdict === "SKIP").length;
console.log(`\n${failed ? `${failed} FAILED` : "No failures"}, ${rows.filter((r) => r.verdict === "PASS").length} passed, ${skipped} skipped.`);

const volume = spawnSync("osascript", ["-e", "get volume settings"], { encoding: "utf8" }).stdout.trim();
const reportFile = path.resolve(option("--report") ?? path.join(buildDir, SELF_TEST ? "self-test-report.json" : "report.json"));
writeFileSync(reportFile, `${JSON.stringify({ at: new Date().toISOString(), mode: SELF_TEST ? "self-test" : "probe", darwin: os.release(), macOS: spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).stdout.trim(), volume, route: data.route ?? null, rows, data }, null, 2)}\n`);
console.log(`Report: ${reportFile}`);
process.exit(failed || crashed ? 1 : 0);
