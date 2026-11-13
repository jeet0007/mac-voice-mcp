/** The flight recorder: off by default, numbers only, flags, retention, no network. Stubs only: no mic, no speakers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, statSync, utimesSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "test", "fixtures");
const ENTRY = path.join(ROOT, "dist", "index.js");
const MARKER = "zebrafruitmarker";

function sandbox(extra = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voice-flight-"));
  const home = path.join(dir, "home");
  const cache = path.join(dir, "cache");
  const bin = path.join(dir, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const b of ["rec", "whisper-cli", "whisper-server"]) symlinkSync(path.join(FIXTURES, "installable", b), path.join(bin, b));
  writeFileSync(path.join(dir, "log.txt"), "");
  mkdirSync(path.join(cache, "models"), { recursive: true });
  const model = Buffer.alloc(1_100_000);
  model.writeUInt32LE(0x67676d6c, 0);
  writeFileSync(path.join(cache, "models", "ggml-tiny.en.bin"), model);
  const env = {
    HOME: home,
    PATH: [path.join(FIXTURES, "bin"), bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
    STUB_LOG: path.join(dir, "log.txt"),
    VOICE_MCP_CACHE_DIR: cache,
    VOICE_MCP_WHISPER_MODEL: "tiny.en",
    VOICE_MCP_RECORDER: "sox",
    VOICE_MCP_CHIME: "0",
    VOICE_MCP_EXTRA_PATH: "",
    VOICE_MCP_PHASE_FILE: "0",
    ...extra,
  };
  return { dir, cache, flight: path.join(cache, "flight"), env };
}

async function withClient(env, fn) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY], env, stderr: "pipe" });
  const client = new Client({ name: "flight", version: "0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

const events = (flight) =>
  readdirSync(flight)
    .filter((n) => n.endsWith(".jsonl"))
    .flatMap((n) => readFileSync(path.join(flight, n), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
const speak = (client, t) => client.callTool({ name: "speak_and_listen", arguments: { text_to_speak: t } });

test("off by default: a full stubbed turn creates no flight folder", async () => {
  const sb = sandbox();
  await withClient(sb.env, async (client) => {
    const r = await speak(client, "Hello there");
    assert.equal(r.isError, false);
    const f = await client.callTool({ name: "flag", arguments: {} });
    assert.equal(f.isError, true);
    assert.match(f.content[0].text, /off/);
  });
  assert.equal(existsSync(sb.flight), false);
});

test("on: a turn writes the pipeline events, never the transcript or spoken text, with 0600/0700", async () => {
  const sb = sandbox({ VOICE_MCP_FLIGHT_RECORDER: "on" });
  await withClient(sb.env, async (client) => {
    const r = await speak(client, `Please confirm the ${MARKER} change`);
    assert.equal(r.isError, false);
  });
  const ev = events(sb.flight);
  const names = ev.map((e) => e.ev);
  for (const want of ["listen.start", "listen.end", "stt.done", "speak.start", "speak.end"]) assert.ok(names.includes(want), `${want} in ${names}`);
  const end = ev.find((e) => e.ev === "listen.end");
  assert.match(end.reason, /^(end-of-turn|max-duration|no-speech)$/);
  assert.equal(typeof end.totalMs, "number");
  const stt = ev.find((e) => e.ev === "stt.done");
  assert.equal(stt.chars, "Stub transcript from the server.".length);
  assert.equal(ev.find((e) => e.ev === "speak.end").finished, true);
  const raw = readdirSync(sb.flight).map((n) => readFileSync(path.join(sb.flight, n), "utf8")).join("");
  assert.ok(!raw.includes(MARKER), "spoken text is not in the log");
  assert.ok(!raw.includes("Stub transcript"), "the transcript is not in the log");
  assert.equal(statSync(sb.flight).mode & 0o777, 0o700);
  for (const n of readdirSync(sb.flight)) assert.equal(statSync(path.join(sb.flight, n)).mode & 0o777, 0o600);
});

test("flag: markdown with summary and recent events; WAV only in audio mode and at most the ring length", async () => {
  for (const mode of ["on", "audio"]) {
    const sb = sandbox({ VOICE_MCP_FLIGHT_RECORDER: mode, VOICE_MCP_FLIGHT_AUDIO_SECONDS: "5" });
    await withClient(sb.env, async (client) => {
      await speak(client, "Hello");
      const f = await client.callTool({ name: "flag", arguments: { note: "cut me off" } });
      assert.equal(f.isError, false, f.content[0].text);
      assert.match(f.content[0].text, /last turn ended by/);
    });
    const flags = path.join(sb.flight, "flags");
    const names = readdirSync(flags);
    const md = readFileSync(path.join(flags, names.find((n) => n.endsWith(".md"))), "utf8");
    assert.match(md, /Note: cut me off/);
    assert.match(md, /last turn ended by \S+ after [\d.]+ s; last reply finished: yes, done/);
    assert.match(md, /"ev":"listen\.end"/);
    assert.equal(statSync(path.join(flags, names.find((n) => n.endsWith(".md")))).mode & 0o777, 0o600);
    const wav = names.find((n) => n.endsWith(".wav"));
    if (mode === "on") assert.equal(wav, undefined, "no audio unless audio mode");
    else {
      assert.ok(wav, "audio mode writes a WAV");
      const buf = readFileSync(path.join(flags, wav));
      assert.equal(buf.toString("ascii", 0, 4), "RIFF");
      assert.equal(buf.toString("ascii", 8, 12), "WAVE");
      assert.equal(buf.readUInt32LE(24), 16000);
      assert.equal(buf.readUInt16LE(22), 1);
      assert.equal(buf.readUInt32LE(40), buf.length - 44);
      assert.ok(buf.length - 44 > 0 && buf.length - 44 <= 5 * 32000, `${buf.length - 44} bytes`);
      assert.equal(statSync(path.join(flags, wav)).mode & 0o777, 0o600);
    }
  }
});

test("CLI: flag, flight status and flight purge", () => {
  const sb = sandbox({ VOICE_MCP_FLIGHT_RECORDER: "on" });
  const run = (...args) => spawnSync(process.execPath, [ENTRY, ...args], { env: sb.env, encoding: "utf8" });
  assert.equal(existsSync(sb.flight), false);
  const flag = run("flag", "that", "was", "wrong");
  assert.equal(flag.status, 0, flag.stderr);
  assert.match(flag.stderr, /flag-.*\.md/);
  assert.ok(readdirSync(path.join(sb.flight, "flags")).some((n) => n.endsWith(".md")));
  assert.match(run("flight", "status").stderr, /Flight recorder: on[\s\S]*2 file/);
  assert.equal(run("flight", "purge").status, 0);
  assert.equal(existsSync(sb.flight), false);
  const off = spawnSync(process.execPath, [ENTRY, "flag"], { env: { ...sb.env, VOICE_MCP_FLIGHT_RECORDER: "off" }, encoding: "utf8" });
  assert.equal(off.status, 1);
  assert.equal(existsSync(sb.flight), false);
});

test("retention: old files are swept, new ones stay; purge removes everything", async () => {
  const sb = sandbox({ VOICE_MCP_FLIGHT_RECORDER: "on", VOICE_MCP_FLIGHT_DAYS: "3", VOICE_MCP_CACHE_DIR: undefined });
  process.env.VOICE_MCP_CACHE_DIR = sb.cache;
  process.env.VOICE_MCP_FLIGHT_RECORDER = "on";
  process.env.VOICE_MCP_FLIGHT_DAYS = "3";
  const f = await import("../dist/flight.js");
  mkdirSync(path.join(sb.flight, "flags"), { recursive: true });
  const old = path.join(sb.flight, "events-2020-01-01.jsonl");
  const oldFlag = path.join(sb.flight, "flags", "flag-old.md");
  const fresh = path.join(sb.flight, "events-2999-01-01.jsonl");
  for (const p of [old, oldFlag, fresh]) writeFileSync(p, "{}\n");
  const longAgo = new Date(Date.now() - 5 * 86_400_000);
  utimesSync(old, longAgo, longAgo);
  utimesSync(oldFlag, longAgo, longAgo);
  assert.equal(f.flightSweep(), 2);
  assert.equal(existsSync(old) || existsSync(oldFlag), false);
  assert.equal(existsSync(fresh), true);
  assert.ok(f.flightPurge() >= 1);
  assert.equal(existsSync(sb.flight), false);
});

test("an unsafe string field is dropped, and the day's file is capped", async () => {
  const sb = sandbox();
  process.env.VOICE_MCP_CACHE_DIR = sb.cache;
  process.env.VOICE_MCP_FLIGHT_RECORDER = "on";
  const f = await import("../dist/flight.js");
  f.flightEvent("probe", { reason: "done", text: "this is prose with spaces", n: 3, bad: Number.NaN });
  const [e] = events(sb.flight);
  assert.deepEqual([e.reason, e.text, e.n, e.bad], ["done", undefined, 3, null]);
  const file = path.join(sb.flight, readdirSync(sb.flight).find((n) => n.endsWith(".jsonl")));
  f.flightPurge(); // forgets the remembered sizes
  mkdirSync(sb.flight, { recursive: true });
  writeFileSync(file, "x".repeat(f.MAX_DAY_BYTES) + "\n");
  f.flightEvent("late");
  f.flightEvent("later");
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("{"));
  assert.equal(lines.length, 1, "one recorder.full line, then nothing");
  assert.equal(JSON.parse(lines[0]).ev, "recorder.full");
});

test("the recorder module imports nothing that can reach the network", () => {
  const src = readFileSync(path.join(ROOT, "src", "flight.ts"), "utf8");
  const imports = [...src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
  assert.ok(imports.length >= 4);
  for (const spec of imports) {
    const bare = spec.replace(/^node:/, "");
    assert.ok(!/^(https?|net|tls|dgram|dns|http2|child_process|worker_threads|cluster)(\/|$)/.test(bare), `forbidden import ${spec}`);
    assert.ok(spec.startsWith(".") || spec.startsWith("node:"), `only relative or node: imports: ${spec}`);
  }
  assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|WebSocket/);
});
