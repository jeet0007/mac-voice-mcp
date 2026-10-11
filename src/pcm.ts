/** Small PCM helpers for the Kokoro voice (pure, unit-tested). */

/** Float samples (-1…1) → 16-bit little-endian PCM, clipped. */
export function floatToPcm16(samples: Float32Array): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), i * 2);
  }
  return buf;
}

/**
 * Resample 16-bit mono PCM by linear interpolation (24 kHz → 16 kHz for whisper). Good enough
 * for speech recognition, which is all it's used for; playback always uses the original rate.
 */
export function resamplePcm16(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  const inCount = Math.floor(pcm.length / 2);
  if (fromRate === toRate || inCount === 0) return Buffer.from(pcm.subarray(0, inCount * 2));
  const outCount = Math.floor((inCount * toRate) / fromRate);
  const out = Buffer.alloc(outCount * 2);
  const step = fromRate / toRate;
  for (let i = 0; i < outCount; i++) {
    const x = i * step;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, inCount - 1);
    const frac = x - i0;
    const v = pcm.readInt16LE(i0 * 2) * (1 - frac) + pcm.readInt16LE(i1 * 2) * frac;
    out.writeInt16LE(Math.round(v), i * 2);
  }
  return out;
}

/** Seconds of audio in a 16-bit mono WAV file's data chunk (`say` may add chunks before it). 0 if there is none. */
export function wavSeconds(wav: Buffer): number {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF") return 0;
  let rate = 16_000;
  let off = 12;
  while (off + 8 <= wav.length) {
    const id = wav.toString("ascii", off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === "fmt " && off + 16 <= wav.length) rate = wav.readUInt32LE(off + 12) || rate;
    if (id === "data") return Math.min(size, wav.length - off - 8) / 2 / rate;
    off += 8 + size + (size % 2);
  }
  return 0;
}

/** A 44-byte WAV header for 16-bit mono PCM. */
export function wavHeaderFor(dataBytes: number, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}
