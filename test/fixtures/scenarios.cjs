// The synthetic mic audio (16 kHz mono) that both mic stubs play: `rec` (test/fixtures/installable/rec)
// and the audio worker (test/stubs/audio-worker.mjs). STUB_SCENARIO means the same thing on each.
const SR = 16000;
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
const noise = (sec, amp = 40) => Array.from({ length: Math.round(SR * sec) }, () => Math.round(rand() * amp));
// Speech-like: a 180 Hz voice with a 4 Hz syllable envelope, loud enough to stand out.
const speech = (sec) => Array.from({ length: Math.round(SR * sec) }, (_, i) =>
  Math.round(8000 * Math.sin((2 * Math.PI * 180 * i) / SR) * (0.55 + 0.45 * Math.sin((2 * Math.PI * 4 * i) / SR))));
const burst = (sec) => Array.from({ length: Math.round(SR * sec) }, (_, i) => (i % 2 ? 9000 : -9000));
const scripts = {
  answer: () => [noise(1), speech(1.5), noise(0.6), speech(1.2)], // a mid-answer pause shorter than 1.2 s
  cough: () => [noise(1), burst(0.15), noise(2), speech(1.5)],
  "cough-only": () => [noise(1), burst(0.15), noise(3)],
  silent: () => [],
  zero: () => [],
  long: () => [noise(0.5), speech(60)],
  // Two utterances, the first after Claude's first say and the second 2 s (real time) later, then silence for good.
  call: () => [noise(5), speech(1.5), noise(20), speech(1.5), noise(2.5)],
  dies: () => [noise(10)],
  bargein: () => [],
  talk: () => [],
};
/** Samples as 30 ms frames (the last one may be short). */
const toFrames = (samples) => {
  const frames = [];
  for (let i = 0; i < samples.length; i += 480) frames.push(samples.slice(i, i + 480));
  return frames;
};
/** The frames a scenario starts with. Built only for the one in use ("long" is a minute of audio). */
const scenarioFrames = (scenario) => scripts[scenario]().flatMap(toFrames);
/** What follows a scenario for as long as the mic is open. */
const tailFrame = (scenario) => (scenario === "zero" ? new Array(480).fill(0) : noise(0.03));
const toPcm = (frame) => {
  const buf = Buffer.alloc(frame.length * 2);
  frame.forEach((v, j) => buf.writeInt16LE(v, j * 2));
  return buf;
};
module.exports = { speech, toFrames, scenarioFrames, tailFrame, toPcm };
