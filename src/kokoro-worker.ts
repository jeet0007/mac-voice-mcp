/**
 * The Kokoro voice, in its own process.
 *
 * Kokoro (kokoro-js + onnxruntime) is a ~330 MB model that takes seconds to load and holds
 * hundreds of MB of memory, so it runs here, kept warm between turns, instead of inside the MCP
 * server. If it crashes or leaks, the server just starts a fresh one.
 *
 * Protocol: one JSON object per line.
 *   in  (stdin): {type:"speak", id, chunks:[text…]}  {type:"cancel", id}
 *   out (fd 3):  {type:"ready", voice, voices, loadMs}
 *                {type:"audio", id, seq, pcm}      pcm = base64 16-bit little-endian, 24 kHz mono
 *                {type:"done", id, cancelled, rssMb}
 *                {type:"error", id?, message, fatal?}
 * stdout is not used for messages: libraries print to it (e.g. a voice table), so it's left to logs.
 *
 * Settings come from the environment (set by kokoro.ts): KOKORO_DIR, KOKORO_DTYPE, KOKORO_VOICE,
 * KOKORO_SPEED, KOKORO_ALLOW_DOWNLOAD ("1" only during an install the user agreed to).
 */
import { createWriteStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { floatToPcm16 } from "./pcm.js";

const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

interface RawAudio {
  audio: Float32Array;
  sampling_rate: number;
}
interface KokoroTTSInstance {
  voices: Record<string, unknown>;
  generate(text: string, opts: { voice: string; speed?: number }): Promise<RawAudio>;
}
interface KokoroModule {
  KokoroTTS: {
    from_pretrained(id: string, opts: Record<string, unknown>): Promise<KokoroTTSInstance>;
  };
  env: { cacheDir: string; allowRemoteModels: boolean; allowLocalModels?: boolean };
}

const out = createWriteStream("", { fd: 3 });
out.on("error", () => process.exit(0)); // the server went away
const send = (msg: Record<string, unknown>) => out.write(JSON.stringify(msg) + "\n");

async function main(): Promise<void> {
  const dir = process.env.KOKORO_DIR;
  if (!dir) throw new Error("KOKORO_DIR is not set");
  const dtype = process.env.KOKORO_DTYPE === "q8" ? "q8" : "fp32";
  const speed = Number(process.env.KOKORO_SPEED) > 0 ? Number(process.env.KOKORO_SPEED) : 1;

  const t0 = Date.now();
  // entry.mjs re-exports KokoroTTS and transformers' env from the same install, so they share state.
  const mod = (await import(pathToFileURL(path.join(dir, "entry.mjs")).href)) as KokoroModule;
  mod.env.cacheDir = path.join(dir, "models");
  mod.env.allowRemoteModels = process.env.KOKORO_ALLOW_DOWNLOAD === "1";
  let lastProgress = -1;
  const tts = await mod.KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
    dtype,
    device: "cpu",
    progress_callback: (p: { status?: string; file?: string; progress?: number }) => {
      if (p.status !== "progress" || !p.file?.endsWith(".onnx")) return;
      const pct = Math.floor((p.progress ?? 0) / 10) * 10;
      if (pct !== lastProgress) {
        lastProgress = pct;
        send({ type: "progress", message: `downloading the Kokoro model: ${pct}%` });
      }
    },
  });

  const voices = Object.keys(tts.voices);
  const wanted = process.env.KOKORO_VOICE || "af_heart";
  const voice = voices.includes(wanted) ? wanted : "af_heart";
  if (voice !== wanted) console.error(`[kokoro] unknown voice "${wanted}", using af_heart`);
  send({ type: "ready", voice, voices, loadMs: Date.now() - t0 });

  // One request at a time; a cancel flips its flag and the loop stops at the next chunk.
  const cancelled = new Set<string>();
  let queue = Promise.resolve();
  const speakRequest = async (id: string, chunks: string[]) => {
    for (let seq = 0; seq < chunks.length; seq++) {
      // Generating blocks this process's event loop, so let it read stdin (a cancel) between chunks.
      await new Promise((r) => setImmediate(r));
      if (cancelled.has(id)) break;
      const audio = await tts.generate(chunks[seq]!, { voice, speed });
      if (cancelled.has(id)) break;
      send({ type: "audio", id, seq, pcm: floatToPcm16(audio.audio).toString("base64") });
    }
    send({ type: "done", id, cancelled: cancelled.delete(id), rssMb: Math.round(process.memoryUsage().rss / 1e6) });
  };

  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let msg: { type?: string; id?: string; chunks?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const id = String(msg.id ?? "");
    if (msg.type === "cancel") cancelled.add(id);
    else if (msg.type === "speak" && Array.isArray(msg.chunks)) {
      const chunks = msg.chunks.map(String);
      queue = queue
        .then(() => speakRequest(id, chunks))
        .catch((e: unknown) => {
          cancelled.delete(id);
          send({ type: "error", id, message: e instanceof Error ? e.message : String(e) });
        });
    }
  });
  // The server closed our stdin (it exited, or was killed): stop too, never linger.
  lines.on("close", () => void queue.finally(() => process.exit(0)));
}

main().catch((e: unknown) => {
  send({ type: "error", message: e instanceof Error ? e.message : String(e), fatal: true });
  out.end(() => process.exit(1));
});
