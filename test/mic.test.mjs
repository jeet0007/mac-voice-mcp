// Who has the mic (src/audio/mic.ts through openAudio): the lock across processes, and the work
// listener giving way in this one, each released only once its recorder has really exited.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(path.join(os.tmpdir(), "voice-mcp-mic-"));
const log = path.join(dir, "log.txt");
writeFileSync(log, "");
Object.assign(process.env, {
  STUB_LOG: log,
  STUB_SCENARIO: "silent",
  STUB_EXIT_DELAY_MS: "600",
  VOICE_MCP_RECORDER: "sox",
  VOICE_MCP_EXTRA_PATH: "",
  VOICE_MCP_CACHE_DIR: path.join(dir, "cache"),
  PATH: [path.join(ROOT, "test", "fixtures", "installable"), process.env.PATH].join(path.delimiter),
});
const { openAudio, MicBusyError } = await import("../dist/audio/device.js");
const { lockFile } = await import("../dist/audio/mic.js");

/** Another live process (our parent) holds the lock. */
const elsewhere = () => {
  mkdirSync(path.dirname(lockFile()), { recursive: true });
  writeFileSync(lockFile(), JSON.stringify({ pid: process.ppid, since: Date.now() }));
};
/** Read one frame, so the recorder is running. */
const recording = async (session) => {
  const frames = session.frames();
  await frames.next();
  return frames;
};

test("a turn waits while another process holds the mic, and takes it once that one lets go", async () => {
  elsewhere();
  let waited = 0;
  const opening = openAudio({ purpose: "turn", onWait: () => waited++ });
  setTimeout(() => rmSync(lockFile()), 400);
  const session = await opening;
  assert.equal(waited, 1);
  assert.equal(JSON.parse(readFileSync(lockFile(), "utf8")).pid, process.pid);
  await session.close();
  assert.ok(!existsSync(lockFile()));
});

test("a turn takes the mic from the work listener, once the work listener's recorder has exited", async () => {
  writeFileSync(log, "");
  const background = await openAudio({ purpose: "worklisten" });
  await recording(background);
  assert.ok(!existsSync(lockFile()), "the work listener never takes the lock");
  const turn = await openAudio({ purpose: "turn" });
  assert.ok(background.signal.aborted, "the work listener was told to stop");
  assert.match(readFileSync(log, "utf8"), /rec stopped\nrec exited\n$/, "its recorder was gone before the turn got the mic");
  await background.ended;
  await turn.close();
});

test("the work listener gives up while another process holds the mic, and stops as soon as one takes it", async () => {
  elsewhere();
  await assert.rejects(openAudio({ purpose: "worklisten" }), MicBusyError);
  rmSync(lockFile());

  writeFileSync(log, "");
  const background = await openAudio({ purpose: "worklisten" });
  const frames = await recording(background);
  elsewhere();
  await background.ended;
  assert.match(readFileSync(log, "utf8"), /rec stopped\nrec exited\n$/);
  assert.deepEqual(await frames.next(), { value: undefined, done: true }, "its frames end");
  rmSync(lockFile());
});
