/**
 * The native backend: the audio worker (native/audio-worker.swift) runs one macOS voice-processing
 * unit that owns the mic and the speaker, so what it plays is cancelled from what the mic hears.
 * Internal to src/audio/: device.ts starts one for a call on allowlisted speakers. The wire is protocol.ts.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { debug } from "../config.js";
import { chunkForSpeech } from "../kokoro-text.js";
import { nativeBin } from "../native-build.js";
import { resamplePcm16, wavData } from "../pcm.js";
import { activeChildren, startWaiting, tail, type Waiting } from "../proc.js";
import { builtInCommand } from "../speech/synthesize.js";
import { SPEECH_RATE, type Playback, type PlayEnd, type Sound } from "./device.js";
import { FRAME_BYTES, parseEvent, serializeCommand, type Command, type WorkerEvent } from "./protocol.js";

/** Long enough to answer a first-time mic permission prompt, mostly. */
const START_TIMEOUT_MS = 10_000;
/** The worker fades out and exits within milliseconds of stdin closing; this is for one that hangs. */
const STOP_TIMEOUT_MS = 2000;
/**
 * Frames count as echo this long after the unit starts, until the canceller has converged (H2). The
 * probe heard no false onset in the first 5 s of a reply with no calibration (residue median -100 dB),
 * so convergence is already under a frame or two there; 500 ms is a margin for other Macs and rooms
 * that costs nothing audible, since the call's greeting plays then.
 */
const CONVERGE_MS = 500;
/** Speech goes to the worker in 100 ms commands (at SPEECH_RATE), so a long sentence never holds up a gain or a stop behind it. */
const PCM_COMMAND_BYTES = 4800;

type Ack = Extract<WorkerEvent, { ev: "ack" }>;

/** Why a worker ended on its own. */
export class WorkerLost extends Error {
  override name = "WorkerLost";
  constructor(
    message: string,
    /** The input or output device changed: the worker is fine, the route isn't the one it started on. */
    readonly routeChanged: boolean,
  ) {
    super(message);
  }
}

export interface Worker {
  /** Mic audio in FRAME_BYTES slices from the start. Ends after close() or return(); throws a WorkerLost when the worker ends on its own. */
  readonly frames: AsyncIterableIterator<Buffer>;
  /** The canceller may not have converged yet: nothing heard now can be trusted as the user. */
  converging(): boolean;
  play(sound: Sound): Playback;
  /** Aborts, with a WorkerLost as its reason, when the worker ends on its own: a device changed, the mic stalled, or it died. */
  readonly lost: AbortSignal;
  /** Close stdin, and resolve once the worker has said mic-closed and exited. Idempotent. */
  close(): Promise<void>;
}

interface Playing {
  at(playedMs: number): void;
  done(reason: PlayEnd, playedMs: number): void;
  fail(err: unknown): void;
}

/** Start the worker. Resolves once its unit runs; rejects, only after it has exited, if it can't start. */
export function start(): Promise<Worker> {
  const child = spawn(nativeBin("audio-worker"), [], { stdio: ["pipe", "pipe", "ignore", "pipe"] });
  activeChildren.add(child);
  child.stdin!.on("error", () => {});
  const lost = new AbortController();
  const acks = new Map<number, (ack: Ack | null) => void>();
  const sounds = new Map<number, Playing>();
  let seq = 0;
  let lastId = 0;
  let readyAt = 0;
  let closing: Promise<void> | null = null;
  let gone = false;
  /** The first reason the worker gave for ending. */
  let failure: WorkerLost | null = null;
  let started!: { resolve: (w: Worker) => void; reject: (e: unknown) => void };
  const starting = new Promise<Worker>((resolve, reject) => (started = { resolve, reject }));
  const startTimer = setTimeout(() => {
    failure ??= new WorkerLost(`The audio worker didn't start within ${START_TIMEOUT_MS / 1000} s.`, false);
    child.kill("SIGKILL");
  }, START_TIMEOUT_MS);

  const send = (command: Command): Promise<Ack | null> => {
    if (gone || closing) return Promise.resolve(null);
    const mine = ++seq;
    child.stdin!.write(serializeCommand(command, mine));
    return new Promise((resolve) => acks.set(mine, resolve));
  };

  // --- The mic: re-cut into whole frames, as a pipe may split them.
  const queue: Buffer[] = [];
  let pending: Buffer = Buffer.alloc(0);
  let end: "done" | Error | null = null;
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  child.stdout!.on("data", (chunk: Buffer) => {
    if (end) return;
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let off = 0;
    for (; pending.length - off >= FRAME_BYTES; off += FRAME_BYTES) {
      queue.push(Buffer.from(pending.subarray(off, off + FRAME_BYTES)));
    }
    pending = pending.subarray(off);
    if (queue.length) notify();
  });

  // --- Built-in speech: `say -o` renders each chunk to a WAV, by a `say` started ahead so its voice is loaded.
  const dir = mkdtempSync(path.join(os.tmpdir(), "voice-mcp-say-"));
  let renders = 0;
  let spare: { key: string; file: string; proc: Waiting } | null = null;
  const startRender = (bin: string, args: string[]) => {
    const file = path.join(dir, `${++renders}.wav`);
    return { key: [bin, ...args].join("\0"), file, proc: startWaiting(bin, [...args, "-o", file, "--file-format=WAVE", `--data-format=LEI16@${SPEECH_RATE}`]) };
  };
  async function render(text: string, signal: AbortSignal): Promise<Buffer> {
    const { bin, args, standby } = await builtInCommand();
    let r = spare;
    spare = null;
    if (r && (r.key !== [bin, ...args].join("\0") || !r.proc.ready)) {
      r.proc.kill(); // the voice setting changed, or it stopped
      r = null;
    }
    r ??= startRender(bin, args);
    if (standby && !closing && !gone) spare = startRender(bin, args); // the next chunk's voice loads while this one renders
    try {
      const result = await r.proc.send(text, { signal, timeoutMs: 60_000 });
      if (result.code !== 0) throw new Error(`Text-to-speech failed (exit ${result.code}): ${tail(result.stderr) || "no output"}`);
      const data = wavData(await readFile(r.file));
      if (!data) throw new Error("Text-to-speech wrote no audio");
      return resamplePcm16(data.pcm, data.rate, SPEECH_RATE);
    } finally {
      void rm(r.file, { force: true });
    }
  }
  // The first reply's voice loads while the call starts.
  void builtInCommand().then(
    ({ bin, args, standby }) => {
      if (standby && !closing && !gone) spare ??= startRender(bin, args);
    },
    () => {},
  );
  async function* builtInSpeech(text: string, signal: AbortSignal): AsyncGenerator<Buffer> {
    for (const chunk of chunkForSpeech(text)) yield await render(chunk, signal);
  }

  function play(sound: Sound): Playback {
    const id = ++lastId;
    const ctl = new AbortController();
    let played = 0;
    let gain = 1;
    let settle!: Playing;
    const done = new Promise<PlayEnd>((resolve, reject) => {
      settle = { at: (ms) => (played = ms), done: (reason, ms) => ((played = ms), resolve(reason)), fail: reject };
    });
    done.catch(() => {}); // the caller handles it; don't crash on an unobserved rejection
    const fail = (err: unknown) => {
      sounds.delete(id);
      settle.fail(err);
    };
    const command = (c: Command) =>
      send(c).then((ack) => {
        if (ack?.playedMs !== undefined) played = ack.playedMs;
        return ack;
      });
    const stop = () => {
      if (ctl.signal.aborted) return;
      ctl.abort();
      void command({ op: "stop", id });
    };
    let paused = false;
    const hold = (pause: boolean) => {
      if (ctl.signal.aborted || paused === pause) return;
      paused = pause;
      void command({ op: pause ? "pause" : "resume", id });
    };
    if (gone || closing) {
      fail(failure ?? new Error("The audio worker has stopped."));
      return { done, duck: () => {}, pause: () => {}, resume: () => {}, stop: () => {}, playedMs: () => 0 };
    }
    sounds.set(id, settle);
    void command(sound.kind === "cue" ? { op: "play", id, file: sound.file, gain: sound.volume } : { op: "play", id, rate: SPEECH_RATE }).then((ack) => {
      if (ack && ack.status !== "ok") fail(new Error(`The audio worker couldn't play it (${ack.status}).`));
    });
    const source = sound.kind === "speech" ? sound.chunks : sound.kind === "voice" ? builtInSpeech(sound.text, ctl.signal) : null;
    if (source) {
      void (async () => {
        for await (const pcm of source) {
          if (ctl.signal.aborted || !sounds.has(id)) return;
          for (let i = 0; i < pcm.length; i += PCM_COMMAND_BYTES) void command({ op: "pcm", id, b64: pcm.subarray(i, i + PCM_COMMAND_BYTES).toString("base64") });
        }
        if (!ctl.signal.aborted) void command({ op: "end", id });
      })().catch((err: unknown) => {
        if (ctl.signal.aborted) return;
        stop();
        fail(err);
      });
    }
    return {
      done,
      duck(g) {
        if (ctl.signal.aborted || g === gain) return;
        gain = g;
        void command({ op: "gain", id, value: g, rampMs: 10 });
      },
      pause: () => hold(true),
      resume: () => hold(false),
      stop,
      playedMs: () => played,
    };
  }

  const worker: Worker = {
    frames: {
      [Symbol.asyncIterator]: () => worker.frames,
      async next() {
        for (;;) {
          const frame = queue.shift();
          if (frame) return { value: frame, done: false };
          if (end === "done") return { value: undefined, done: true };
          if (end) throw end;
          await new Promise<void>((r) => (wake = r));
        }
      },
      // Stops reading only: the worker keeps playing until close().
      async return() {
        end ??= "done";
        queue.length = 0;
        notify();
        return { value: undefined, done: true };
      },
    },
    converging: () => Date.now() - readyAt < CONVERGE_MS,
    play,
    lost: lost.signal,
    close: () =>
      (closing ??= (async () => {
        end ??= "done";
        queue.length = 0;
        notify();
        spare?.proc.kill();
        child.stdin!.end();
        const kill = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
        await exited;
        clearTimeout(kill);
      })()),
  };

  createInterface({ input: child.stdio[3] as Readable }).on("line", (line) => {
    const e = parseEvent(line);
    if (!e) return debug("audio worker: an event protocol.ts can't read");
    switch (e.ev) {
      case "ready":
        readyAt = Date.now();
        clearTimeout(startTimer);
        started.resolve(worker);
        break;
      case "ack":
        acks.get(e.seq)?.(e);
        acks.delete(e.seq);
        break;
      case "pos":
        sounds.get(e.id)?.at(e.playedMs);
        break;
      case "done":
        sounds.get(e.id)?.done(e.reason, e.playedMs);
        sounds.delete(e.id);
        break;
      case "error":
        failure ??= new WorkerLost(`The audio worker failed (${e.stage} ${e.code}): ${e.message}.`, false);
        break;
      case "route-changed":
        failure ??= new WorkerLost(`The ${e.which} device changed.`, true);
        break;
      case "frames-dropped":
        debug(`audio worker: ${e.count} mic frames dropped`);
        break;
      case "mic-closed":
        break;
    }
  });

  /** Resolves once the worker is gone and its pipes are closed, so every event has been read. */
  const exited = new Promise<void>((resolve) => {
    const finish = (why: string) => {
      if (gone) return;
      gone = true;
      clearTimeout(startTimer);
      activeChildren.delete(child);
      spare?.proc.kill();
      rmSync(dir, { recursive: true, force: true });
      const reason = failure ?? new WorkerLost(`The audio worker stopped (${why}).`, false);
      for (const ack of acks.values()) ack(null);
      acks.clear();
      for (const sound of sounds.values()) sound.fail(reason); // no `done` came for it: the worker died
      sounds.clear();
      end = closing ? "done" : reason;
      notify();
      if (!closing) lost.abort(reason);
      started.reject(reason); // a no-op once it was ready
      resolve();
    };
    child.on("error", (e) => finish(e.message));
    child.on("close", (code, signal) => finish(`exit ${code ?? signal}`));
  });

  return starting;
}

