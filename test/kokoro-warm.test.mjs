// prewarmKokoro: the voice loads in the background before it's needed, only when Kokoro is in use
// and already on disk, and never when it isn't.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(path.join(os.tmpdir(), "voice-mcp-kwarm-"));
const log = path.join(dir, "log.txt");
writeFileSync(log, "");

function fakeKokoro(root, { model = true } = {}) {
  mkdirSync(path.join(root, "node_modules", "kokoro-js"), { recursive: true });
  writeFileSync(path.join(root, "node_modules", "kokoro-js", "package.json"), '{"name":"kokoro-js","version":"1.2.1"}\n');
  writeFileSync(path.join(root, "entry.mjs"), readFileSync(path.join(ROOT, "test", "fixtures", "kokoro", "entry.mjs")));
  if (model) {
    const onnx = path.join(root, "models", "onnx-community", "Kokoro-82M-v1.0-ONNX", "onnx");
    mkdirSync(onnx, { recursive: true });
    writeFileSync(path.join(onnx, "model.onnx"), "fake");
  }
}

const withModel = path.join(dir, "with-model");
fakeKokoro(withModel);
Object.assign(process.env, { STUB_LOG: log, VOICE_MCP_KOKORO_DIR: withModel, VOICE_MCP_TTS: "" });
const { prewarmKokoro, stopKokoro, kokoroVoiceLabel } = await import("../dist/kokoro.js");
const { CONFIG } = await import("../dist/config.js");

const loads = () => (readFileSync(log, "utf8").match(/^kokoro-load/gm) ?? []).length;
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
};

test("prewarmKokoro loads the model in the background, once, without speaking", async () => {
  prewarmKokoro();
  prewarmKokoro(); // a worker that is already starting is left alone
  await until(() => loads() >= 1);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(loads(), 1);
  assert.ok(!/kokoro-generate/.test(readFileSync(log, "utf8")), "nothing was spoken");
  assert.match(readFileSync(log, "utf8"), /download=false/, "never downloads");
  stopKokoro();
});

test("after the worker was stopped (idle or recycled), prewarmKokoro starts it again", async () => {
  const before = loads();
  prewarmKokoro();
  await until(() => loads() > before);
  assert.equal(loads(), before + 1);
  stopKokoro();
});

test("nothing is loaded when Kokoro isn't in use: the model is missing, or VOICE_MCP_TTS=say", async () => {
  const before = loads();
  const saved = CONFIG.kokoroDir;
  const bare = path.join(dir, "no-model");
  fakeKokoro(bare, { model: false });
  CONFIG.kokoroDir = bare;
  prewarmKokoro();
  CONFIG.kokoroDir = saved;
  const savedTts = CONFIG.tts;
  CONFIG.tts = "say";
  prewarmKokoro();
  CONFIG.tts = savedTts;
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(loads(), before);
  assert.ok(kokoroVoiceLabel());
});
