// Real speech round trip, no microphone: the real voice speaks known sentences into a file and the
// real whisper.cpp transcribes them. Fails if too many words come back wrong or it's too slow.
// Runs only on macOS with VOICE_MCP_ROUNDTRIP=1 (the "Speech round trip" CI job sets it up).
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const enabled = process.platform === "darwin" && process.env.VOICE_MCP_ROUNDTRIP === "1";

/** Everyday sentences: these must come back (almost) word for word. */
const PLAIN = [
  "The build passed and all tests are green. Should I open the pull request now?",
  "I fixed the login bug and pushed the changes to the main branch.",
  "Do you want me to deploy it now, or wait until tomorrow morning?",
  "The tests took about two minutes and three of them were skipped.",
];
/** Developer jargon: tracked, with a loose limit for now — the numbers show what to improve. */
const JARGON = [
  "I updated the JSON config in index.ts and ran npm test.",
  "The API returned a 404 error from the GitHub endpoint.",
  "Should I merge the pull request into main and tag the new version?",
];
/**
 * Defaults are for a real Mac. GitHub's Mac runners have no GPU for whisper.cpp and only the basic
 * voices, so CI passes looser limits through VOICE_MCP_ROUNDTRIP_LIMITS (JSON). There the test is a
 * regression guard — a broken voice or transcriber scores near 100% wrong — while `doctor` on a real
 * Mac is the quality bar.
 */
const LIMITS = {
  plainEach: 0.25,
  plainOverall: 0.1,
  jargonEach: 0.5,
  warmTranscribeMs: 3000,
  ...JSON.parse(process.env.VOICE_MCP_ROUNDTRIP_LIMITS || "{}"),
};

test("speech round trip: voice → file → whisper.cpp stays accurate and fast", { skip: !enabled && "macOS + VOICE_MCP_ROUNDTRIP=1 only" }, async () => {
  const { synthesizeToFile, chooseVoice } = await import("../dist/audio.js");
  const { transcribe, stopWhisperServer, describeStt } = await import("../dist/stt.js");
  const { ensureModel } = await import("../dist/model.js");
  const { wordErrorRate } = await import("../dist/wer.js");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "voice-roundtrip-"));
  const model = await ensureModel({ download: false });
  const rows = [];
  try {
    for (const [kind, sentences] of [["plain", PLAIN], ["jargon", JARGON]]) {
      for (const [i, sentence] of sentences.entries()) {
        const wav = path.join(tmp, `${kind}-${i}.wav`);
        let t = Date.now();
        await synthesizeToFile(sentence, wav);
        const synthMs = Date.now() - t;
        await transcribe(wav, model); // warm up (first call loads the model)
        t = Date.now();
        const heard = await transcribe(wav, model);
        const transcribeMs = Date.now() - t;
        rows.push({ kind, sentence, heard, ...wordErrorRate(sentence, heard), synthMs, transcribeMs });
      }
    }
  } finally {
    stopWhisperServer();
  }

  const report = { voice: (await chooseVoice()).label, stt: describeStt(), model, limits: LIMITS, rows };
  writeFileSync(process.env.VOICE_MCP_ROUNDTRIP_REPORT ?? path.join(tmp, "roundtrip-report.json"), JSON.stringify(report, null, 2));
  for (const r of rows) console.log(`${r.kind.padEnd(6)} WER ${(r.wer * 100).toFixed(0).padStart(3)}%  ${r.transcribeMs} ms  "${r.sentence}" → "${r.heard}"`);

  const plain = rows.filter((r) => r.kind === "plain");
  const overall = plain.reduce((s, r) => s + r.errors, 0) / plain.reduce((s, r) => s + r.words, 0);
  for (const r of plain) assert.ok(r.wer <= LIMITS.plainEach, `too many wrong words (${r.wer}): "${r.sentence}" → "${r.heard}"`);
  assert.ok(overall <= LIMITS.plainOverall, `overall word error rate ${overall} is above ${LIMITS.plainOverall}`);
  for (const r of rows.filter((x) => x.kind === "jargon")) {
    assert.ok(r.wer <= LIMITS.jargonEach, `jargon badly misheard (${r.wer}): "${r.sentence}" → "${r.heard}"`);
  }
  for (const r of rows) assert.ok(r.transcribeMs <= LIMITS.warmTranscribeMs, `transcribing took ${r.transcribeMs} ms: "${r.sentence}"`);
});
