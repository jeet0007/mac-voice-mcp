// listenForTurn with the stub recorder: the "mic open" cue comes only once audio is flowing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(path.join(os.tmpdir(), "voice-mcp-listen-"));
const log = path.join(dir, "log.txt");
writeFileSync(log, "");
Object.assign(process.env, {
  STUB_LOG: log,
  STUB_SCENARIO: "answer",
  VOICE_MCP_RECORDER: "sox",
  VOICE_MCP_EXTRA_PATH: "",
  PATH: [path.join(ROOT, "test", "fixtures", "installable"), process.env.PATH].join(path.delimiter),
});
const { listenForTurn, MIC_WARMUP_MS } = await import("../dist/audio.js");

test("the chime plays only once the recorder is delivering audio, and the answer is still captured whole", async () => {
  const wav = path.join(dir, "turn.wav");
  let cueAt = null;
  const heard = await listenForTurn(10, wav, undefined, {
    onListening: () => {
      cueAt = readFileSync(log, "utf8");
      return new Promise((r) => setTimeout(r, 5));
    },
  });
  assert.ok(MIC_WARMUP_MS >= 150);
  assert.match(cueAt ?? "", /^rec /m, "the recorder was already running when the cue played");
  assert.equal(heard.reason, "end-of-turn");
  // Stub answer: 1.5 s speech, 0.6 s pause, 1.2 s speech → ~3.3 s + 2 × 0.3 s padding.
  const seconds = (statSync(wav).size - 44) / 32000;
  assert.ok(seconds > 3.5 && seconds < 4.3, `trimmed wav is ${seconds}s`);
});

test("the turn is handed back without waiting for a slow recorder to exit; the recorder is stopped and reports its exit", async () => {
  writeFileSync(log, "");
  process.env.STUB_EXIT_DELAY_MS = "900";
  try {
    const t0 = Date.now();
    const heard = await listenForTurn(10, null, undefined);
    const returnedAt = Date.now() - t0;
    assert.equal(heard.reason, "end-of-turn");
    assert.ok(heard.wav.length > 44 + 3.5 * 32000, "the utterance comes back as a WAV in memory");
    assert.equal(heard.wav.subarray(0, 4).toString(), "RIFF");
    // The stub needs ~0.9 s to exit after SIGTERM: we must have returned before it did.
    assert.ok(!/rec exited/.test(readFileSync(log, "utf8")), "recorder had not exited yet when the turn was returned");
    await heard.recorderExited;
    const exitedAt = Date.now() - t0;
    assert.ok(exitedAt - returnedAt >= 700, `exit came ${exitedAt - returnedAt} ms after the turn was returned`);
    assert.match(readFileSync(log, "utf8"), /rec stopped\nrec exited/, "the recorder was told to stop, then exited");
  } finally {
    delete process.env.STUB_EXIT_DELAY_MS;
  }
});
