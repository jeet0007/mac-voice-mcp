// Drives an audio worker (the real one or the stub) over its three pipes, for tests.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { parseEvent, serializeCommand } from "../../dist/audio/protocol.js";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `seconds` of a sine as mono s16le. */
export function tone(seconds, rate, hz = 440, amplitude = 0.25) {
  const pcm = Buffer.alloc(Math.round(seconds * rate) * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(32767 * amplitude * Math.sin((2 * Math.PI * hz * i) / rate)), i * 2);
  return pcm;
}

const running = new Set();
/** For afterEach: a test that failed half way must not leave its worker holding the run open. */
export const killWorkers = () => running.forEach((child) => child.kill("SIGKILL"));

export function startWorker(command, args = [], env = process.env) {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit", "pipe"], env });
  running.add(child);
  child.on("exit", () => running.delete(child));
  /** Every event, as protocol.ts parsed it, with the time it arrived. */
  const events = [];
  /** fd-3 lines protocol.ts dropped. */
  const malformed = [];
  const waiting = new Set();
  const mic = [];
  child.stdout.on("data", (chunk) => mic.push(chunk));
  child.stdin.on("error", () => {});
  createInterface({ input: child.stdio[3] }).on("line", (line) => {
    const event = parseEvent(line);
    if (!event) return malformed.push(line);
    const stamped = { ...event, at: Date.now() };
    events.push(stamped);
    for (const w of [...waiting]) if (w.match(stamped)) w.resolve(stamped);
  });
  let seq = 0;

  /** The first event that matches, already here or still to come. */
  function waitFor(match, ms = 3000, what = "an event") {
    const seen = events.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const w = { match, resolve: (e) => (clearTimeout(timer), waiting.delete(w), resolve(e)) };
      const timer = setTimeout(() => (waiting.delete(w), reject(new Error(`no ${what} within ${ms} ms; got ${JSON.stringify(events)}`))), ms);
      waiting.add(w);
    });
  }

  return {
    child,
    events,
    malformed,
    waitFor,
    /** Mic audio received so far. */
    mic: () => Buffer.concat(mic),
    exit: new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal }))),
    /** Send one command; resolves with its ack. */
    send(command) {
      const mine = ++seq;
      child.stdin.write(serializeCommand(command, mine));
      return waitFor((e) => e.ev === "ack" && e.seq === mine, 3000, `ack of ${command.op}`);
    },
    /** Send a raw stdin line. */
    write: (line) => child.stdin.write(`${line}\n`),
    /** A stream of PCM in 100 ms commands, as Node will send speech. */
    async sendPcm(id, pcm, rate) {
      const step = (rate / 10) * 2;
      for (let i = 0; i < pcm.length; i += step) await this.send({ op: "pcm", id, b64: pcm.subarray(i, i + step).toString("base64") });
    },
  };
}
