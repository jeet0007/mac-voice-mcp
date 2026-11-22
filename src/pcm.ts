// Small pure PCM and WAV helpers for the Kokoro voice. See docs/specs/speech-output.md.

export function floatToPcm16(samples: Float32Array): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), i * 2);
  }
  return buf;
}

// Linear interpolation: good enough for whisper, its only use; playback keeps the original rate.
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

// `say` may add chunks before the data chunk.
export function wavData(wav: Buffer): { pcm: Buffer; rate: number } | null {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF") return null;
  let rate = 16_000;
  let off = 12;
  while (off + 8 <= wav.length) {
    const id = wav.toString("ascii", off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === "fmt " && off + 16 <= wav.length) rate = wav.readUInt32LE(off + 12) || rate;
    if (id === "data") return { pcm: wav.subarray(off + 8, Math.min(off + 8 + size, wav.length)), rate };
    off += 8 + size + (size % 2);
  }
  return null;
}

export function wavSeconds(wav: Buffer): number {
  const data = wavData(wav);
  return data ? data.pcm.length / 2 / data.rate : 0;
}

