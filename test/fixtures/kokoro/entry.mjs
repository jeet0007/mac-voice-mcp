// A stand-in for the installed kokoro-js (the real one is a ~330 MB model): same API, instant,
// and it logs what it was asked to say.
// FAKE_KOKORO: ok (default) | broken-load | broken-generate (the first sentence works, then it fails).
import fs from "node:fs";

const log = (line) => process.env.STUB_LOG && fs.appendFileSync(process.env.STUB_LOG, line + "\n");
const mode = process.env.FAKE_KOKORO || "ok";
let generated = 0;

export const env = { cacheDir: "", allowRemoteModels: true };

export class KokoroTTS {
  static async from_pretrained(id, opts) {
    log(`kokoro-load ${id} dtype=${opts.dtype} download=${env.allowRemoteModels} cache=${env.cacheDir.endsWith("models")}`);
    if (mode === "broken-load") throw new Error("fake load failure");
    return new KokoroTTS();
  }
  get voices() {
    return { af_heart: {}, af_bella: {}, bf_emma: {} };
  }
  async generate(text, { voice, speed }) {
    log(`kokoro-generate ${JSON.stringify(text)} voice=${voice} speed=${speed}`);
    if (mode === "broken-generate" && generated++ > 0) throw new Error("fake generate failure");
    // 50 ms of a quiet 220 Hz tone per character.
    const n = Math.round(24000 * 0.05 * text.length);
    const audio = new Float32Array(n);
    for (let i = 0; i < n; i++) audio[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / 24000);
    return { audio, sampling_rate: 24000 };
  }
}
