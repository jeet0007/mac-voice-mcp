/**
 * A reply out loud: synthesize, then play. Stateless, with no queue: each caller orders its own
 * replies (the call plays its `say`s one after another; a turn speaks, then listens).
 */
import { play, type Playback, type Sound } from "../audio/device.js";
import { log } from "../config.js";
import { flightEvent } from "../flight.js";
import { kokoroEnabled } from "../kokoro.js";
import { CancelledError } from "../proc.js";
import { kokoroSpeech, type Spoken } from "./synthesize.js";

export interface Reply {
  /** How it was spoken, once it has finished. Rejects with CancelledError once stopped, or with why it couldn't be spoken. */
  readonly done: Promise<Spoken>;
  /** Below 1 quieter (paused, on the process backend), 1 back to normal. Also reaches the built-in voice finishing for Kokoro. */
  duck(gain: number): void;
  stop(): void;
}

/**
 * Speak `text` with the Kokoro voice when it's installed (or VOICE_MCP_TTS=kokoro), otherwise the
 * built-in voice. If Kokoro fails, the built-in voice says whatever it hadn't said yet. Aborting
 * `signal` is stop().
 */
export function speak(text: string, signal?: AbortSignal): Reply {
  const ctl = new AbortController();
  let gain = 1;
  let current: Playback | null = null;
  const stop = () => {
    ctl.abort();
    current?.stop();
  };
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", stop, { once: true });

  const playToEnd = async (sound: Sound): Promise<void> => {
    if (ctl.signal.aborted) throw new CancelledError();
    const playback = play(sound);
    current = playback;
    playback.duck(gain);
    if ((await playback.done) === "stopped") throw new CancelledError();
  };

  const done = (async (): Promise<Spoken> => {
    if (!text) return { engine: "built-in" };
    const t0 = Date.now();
    flightEvent("speak.start", { engine: kokoroEnabled() ? "kokoro" : "say", chars: text.length, words: text.split(/\s+/).filter(Boolean).length });
    try {
      const spoken = await say(text, ctl.signal, playToEnd);
      flightEvent("speak.end", { finished: true, reason: spoken.fallback ? "fallback" : "done", ms: Date.now() - t0 });
      return spoken;
    } catch (err) {
      flightEvent("speak.end", { finished: false, reason: err instanceof CancelledError ? "stopped" : "error", ms: Date.now() - t0 });
      throw err;
    } finally {
      signal?.removeEventListener("abort", stop);
    }
  })();
  return {
    done,
    duck(g) {
      gain = g;
      current?.duck(g);
    },
    stop,
  };
}

async function say(text: string, signal: AbortSignal, playToEnd: (sound: Sound) => Promise<void>): Promise<Spoken> {
  if (!kokoroEnabled()) {
    await playToEnd({ kind: "voice", text });
    return { engine: "built-in" };
  }
  const kokoro = kokoroSpeech(text, signal);
  try {
    const sound = await kokoro.load();
    if (sound) await playToEnd(sound);
    return { engine: "kokoro", ...kokoro.stats };
  } catch (err) {
    if (err instanceof CancelledError || signal.aborted) throw new CancelledError();
    const reason = err instanceof Error ? err.message : String(err);
    log(`The Kokoro voice failed, so the built-in voice is speaking instead: ${reason}`);
    const rest = kokoro.unspoken();
    if (rest) await playToEnd({ kind: "voice", text: rest });
    return { engine: "built-in", fallback: reason };
  }
}
