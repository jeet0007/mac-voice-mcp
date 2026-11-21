// A turn on an audio session with the stub recorder: the "mic open" cue comes only once audio is
// flowing, and the mic is given back only once the recorder has really exited.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  VOICE_MCP_CACHE_DIR: path.join(dir, "cache"),
  PATH: [path.join(ROOT, "test", "fixtures", "installable"), process.env.PATH].join(path.delimiter),
});
const { openAudio } = await import("../dist/audio/device.js");
const { lockFile } = await import("../dist/audio/mic.js");
const { listenForTurn, MIC_WARMUP_MS } = await import("../dist/listen/utterances.js");

test("the chime plays only once the recorder is delivering audio, and the answer is still captured whole", async () => {
  const session = await openAudio({ purpose: "turn" });
  let cueAt = null;
  try {
    const heard = await listenForTurn(session, 10, {
      onListening: () => {
        cueAt = readFileSync(log, "utf8");
        return new Promise((r) => setTimeout(r, 5));
      },
    });
    assert.ok(MIC_WARMUP_MS >= 150);
    assert.match(cueAt ?? "", /^rec /m, "the recorder was already running when the cue played");
    assert.equal(heard.reason, "end-of-turn");
    // Stub answer: 1.5 s speech, 0.6 s pause, 1.2 s speech → ~3.3 s + 2 × 0.3 s padding.
    const seconds = (heard.wav.length - 44) / 32000;
    assert.ok(seconds > 3.5 && seconds < 4.3, `trimmed wav is ${seconds}s`);
    assert.equal(heard.wav.subarray(0, 4).toString(), "RIFF", "the utterance comes back as a WAV in memory");
  } finally {
    await session.close();
  }
});

test("the turn is handed back without waiting for a slow recorder to exit; close() gives the mic back only after it has", async () => {
  writeFileSync(log, "");
  process.env.STUB_EXIT_DELAY_MS = "900";
  try {
    const t0 = Date.now();
    const session = await openAudio({ purpose: "turn" });
    const heard = await listenForTurn(session, 10);
    const returnedAt = Date.now() - t0;
    assert.equal(heard.reason, "end-of-turn");
    // The stub needs ~0.9 s to exit after SIGTERM: we must have returned before it did.
    assert.ok(!/rec exited/.test(readFileSync(log, "utf8")), "recorder had not exited yet when the turn was returned");
    assert.ok(existsSync(lockFile()), "the mic is still ours while the recorder exits");
    await session.close();
    const closedAt = Date.now() - t0;
    assert.ok(closedAt - returnedAt >= 700, `close came ${closedAt - returnedAt} ms after the turn was returned`);
    assert.match(readFileSync(log, "utf8"), /rec stopped\nrec exited/, "the recorder was told to stop, then exited");
    assert.ok(!existsSync(lockFile()), "the mic was given back");
  } finally {
    delete process.env.STUB_EXIT_DELAY_MS;
  }
});

test("a cancelled turn throws CancelledError, and its session still gives the mic back only once the recorder is gone", async () => {
  writeFileSync(log, "");
  process.env.STUB_EXIT_DELAY_MS = "900";
  try {
    const session = await openAudio({ purpose: "turn" });
    const ctl = new AbortController();
    // Cancelled while the recorder runs (onListening: it is delivering audio).
    const turn = listenForTurn(session, 10, { signal: ctl.signal, onListening: () => ctl.abort() });
    await assert.rejects(turn, (e) => e.name === "CancelledError" || /cancel/i.test(e.message));
    assert.ok(!/rec exited/.test(readFileSync(log, "utf8")), "the recorder was still exiting when the cancel was thrown");
    await session.close();
    assert.match(readFileSync(log, "utf8"), /rec stopped\nrec exited/);
    assert.ok(!existsSync(lockFile()));
  } finally {
    delete process.env.STUB_EXIT_DELAY_MS;
  }
});
