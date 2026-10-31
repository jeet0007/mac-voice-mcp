/**
 * The buddy: a soft blob that moves with the voice turn (inspired by xom9ikk/animated-blobs).
 * Pure functions, no `$`: the shape, an SVG with SMIL animation for the app surfaces, and Raster
 * cells for the terminal.
 */

export type Mood = 'speaking' | 'listening' | 'transcribing' | 'waiting' | 'standby' | 'call'

export type Look = {
  /** 0xRRGGBB */
  color: number
  /** One full loop of the shape, in milliseconds. */
  loopMs: number
  /** How far the edge moves, as a share of the radius. */
  wobble: number
  /** Size, as a share of the space it has. */
  size: number
  /** How much the size breathes in and out, as a share. */
  breathe: number
}

export const LOOKS: Record<Mood, Look> = {
  speaking: { color: 0xd97757, loopMs: 2400, wobble: 0.16, size: 1, breathe: 0.04 },
  listening: { color: 0x4f9dde, loopMs: 3200, wobble: 0.08, size: 0.9, breathe: 0.08 },
  transcribing: { color: 0x9b7bd8, loopMs: 1400, wobble: 0.12, size: 0.85, breathe: 0.03 },
  waiting: { color: 0x8a8a8a, loopMs: 5000, wobble: 0.05, size: 0.75, breathe: 0.03 },
  standby: { color: 0x3fa796, loopMs: 6000, wobble: 0.05, size: 0.72, breathe: 0.06 },
  call: { color: 0x34c759, loopMs: 4000, wobble: 0.06, size: 0.8, breathe: 0.1 },
}

const TAU = Math.PI * 2

/**
 * The edge's distance from the centre at angle `theta`, at `p` (0 to 1) through the loop: a few
 * sine waves of different frequencies, each going round a whole number of times per loop, so the
 * loop is seamless.
 */
export function radius(theta: number, p: number, look: Look): number {
  const w = look.wobble
  const wave =
    0.55 * Math.sin(2 * theta + TAU * p + 0.7) +
    0.3 * Math.sin(3 * theta - TAU * 2 * p + 1.9) +
    0.15 * Math.sin(5 * theta + TAU * p + 4.1)
  return look.size * (1 + look.breathe * Math.sin(TAU * p)) * (1 + w * wave)
}

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`
const mix = (a: number, b: number, t: number) => {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/** A closed, smooth SVG path through `n` points of the edge (Catmull-Rom as cubic Béziers). */
export function blobPath(p: number, look: Look, cx: number, cy: number, r: number, n = 10): string {
  const pts = Array.from({ length: n }, (_, k) => {
    const theta = (TAU * k) / n
    const d = r * radius(theta, p, look)
    return [cx + d * Math.cos(theta), cy + d * Math.sin(theta)] as const
  })
  const at = (k: number) => pts[(k + n) % n]!
  const f = (v: number) => v.toFixed(2)
  let d = `M${f(at(0)[0])},${f(at(0)[1])}`
  for (let k = 0; k < n; k++) {
    const [p0, p1, p2, p3] = [at(k - 1), at(k), at(k + 1), at(k + 2)]
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += `C${f(c1[0]!)},${f(c1[1]!)} ${f(c2[0]!)},${f(c2[1]!)} ${f(p2[0])},${f(p2[1])}`
  }
  return `${d}Z`
}

/** The buddy as an SVG that animates itself (SMIL), so the app redraws nothing while it moves. */
export function blobSvg(mood: Mood, px = 40): string {
  const look = LOOKS[mood]
  const frames = 12
  const c = px / 2
  const r = px * 0.36
  const paths = Array.from({ length: frames + 1 }, (_, i) => blobPath(i / frames, look, c, c, r))
  const base = hex(look.color)
  const light = hex(mix(look.color, 0xffffff, 0.45))
  const dark = hex(mix(look.color, 0x000000, 0.2))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}">` +
    `<defs><radialGradient id="g" cx="35%" cy="30%" r="75%">` +
    `<stop offset="0" stop-color="${light}"/><stop offset="0.55" stop-color="${base}"/><stop offset="1" stop-color="${dark}"/>` +
    `</radialGradient></defs>` +
    `<path fill="url(#g)" d="${paths[0]}">` +
    `<animate attributeName="d" dur="${look.loopMs}ms" repeatCount="indefinite" values="${paths.join(';')}"/>` +
    `</path></svg>`
  )
}

const DEFAULT = 0x01000000 // the terminal's own colour
const UPPER = 0x2580 // ▀
const LOWER = 0x2584 // ▄

/**
 * One frame for the terminal: `columns` x `rows` cells, two pixels per cell (half blocks), so the
 * blob is round. Returns the cells encoded as a Raster wants them.
 */
export function blobCells(mood: Mood, p: number, columns: number, rows: number): string {
  const look = LOOKS[mood]
  const h = rows * 2
  const cx = columns / 2
  const cy = h / 2
  const r = Math.min(columns, h) * 0.46
  // At a few pixels across, the full wobble turns into single-pixel spikes: calm it down, and fill
  // a pixel only when most of it is inside (4 x 4 samples).
  const calm: Look = { ...look, wobble: look.wobble * 0.6 }
  const inside = (x: number, y: number) => Math.hypot(x - cx, y - cy) <= r * radius(Math.atan2(y - cy, x - cx), p, calm)
  const pixel = (x: number, y: number): number | null => {
    let hits = 0
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (inside(x + (i + 0.5) / 4, y + (j + 0.5) / 4)) hits++
    if (hits < 8) return null
    const dx = x + 0.5 - cx
    const dy = y + 0.5 - cy
    // Light from the top left, darker towards the bottom right.
    const shade = (-(dx + dy) / (r * 1.6) + 1) / 2
    return shade > 0.5 ? mix(look.color, 0xffffff, (shade - 0.5) * 0.7) : mix(look.color, 0x000000, (0.5 - shade) * 0.35)
  }
  const words = new Uint32Array(columns * rows * 3)
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const top = pixel(col, row * 2)
      const bottom = pixel(col, row * 2 + 1)
      const i = (row * columns + col) * 3
      if (top !== null) words.set([UPPER, top, bottom ?? DEFAULT], i)
      else if (bottom !== null) words.set([LOWER, bottom, DEFAULT], i)
      else words.set([0x20, DEFAULT, DEFAULT], i)
    }
  }
  return base64(new Uint8Array(words.buffer))
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
/** Standard padded base64 (written out: not every engine has Uint8Array.prototype.toBase64). */
export function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += B64[a >> 2]! + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]!
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!
    out += c === undefined ? '=' : B64[c & 63]!
  }
  return out
}
