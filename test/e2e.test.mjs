/**
 * End-to-end: drives the real server over MCP stdio, with stub binaries standing in
 * for say / rec / whisper-cli / whisper-server / brew (see test/fixtures).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, lstatSync, readlinkSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "test", "fixtures");
const ENTRY = path.join(ROOT, "dist", "index.js");

/** A fake ggml model: the right magic bytes and enough size to pass validation. */
function fakeModel(dir, name = "ggml-tiny.en.bin") {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const buf = Buffer.alloc(1_100_000);
  buf.writeUInt32LE(0x67676d6c, 0);
  writeFileSync(file, buf);
  return file;
}

/** Fresh sandbox: its own HOME, a log, and a bin dir that "brew install" writes into. */
function sandbox({ installed = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voice-mcp-test-"));
  const home = path.join(dir, "home");
  const brewTarget = path.join(dir, "brew-bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(brewTarget, { recursive: true });
  if (installed) for (const bin of ["rec", "whisper-cli", "whisper-server"]) symlinkSync(path.join(FIXTURES, "installable", bin), path.join(brewTarget, bin));
  const log = path.join(dir, "log.txt");
  writeFileSync(log, "");
  return {
    dir,
    home,
    log,
    readLog: () => readFileSync(log, "utf8"),
    env: (extra = {}) => ({
      HOME: home,
      PATH: [path.join(FIXTURES, "bin"), brewTarget, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
      STUB_LOG: log,
      STUB_BREW_TARGET: brewTarget,
      VOICE_MCP_WHISPER_MODEL: "tiny.en",
      VOICE_MCP_RECORDER: "sox",
      VOICE_MCP_CHIME: "0",
      // Don't add Homebrew's folders to PATH: on a real Mac they contain the real tools,
      // and these tests must only ever see the stubs.
      VOICE_MCP_EXTRA_PATH: "",
      ...extra,
    }),
  };
}

async function connect(env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY], env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (d) => (stderr += d));
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(transport);
  return { client, transport, stderr: () => stderr };
}

const text = (r) => r.content.map((c) => c.text).join("\n");

test("lists two tools, two prompts, and compact server instructions", async () => {
  const sb = sandbox();
  const { client } = await connect(sb.env());
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["speak_and_listen", "voice_setup"]);
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    assert.deepEqual(prompts, ["setup", "voice_mode"]);
    assert.ok(Buffer.byteLength(client.getInstructions() ?? "") < 2048, "Claude Code truncates instructions at 2 KB");
  } finally {
    await client.close();
  }
});

test("a full turn: rewrites markdown for speech, transcribes via the warm server, reuses it", async () => {
  const sb = sandbox();
  fakeModel(path.join(sb.home, ".cache", "mac-voice-mcp", "models"));
  const { client } = await connect(sb.env());
  try {
    const r1 = await client.callTool({ name: "speak_and_listen", arguments: { text_to_speak: "## Done\n- all **green** ✅\n- see /a/b/c/app.ts:12" } });
    assert.equal(r1.isError, false);
    assert.equal(r1.content[0].text, "Stub transcript from the server.");
    assert.match(text(r1), /voice-mcp note: .*file paths/);
    assert.match(text(r1), /voice-mcp timing: spoke [\d.]+ s · listened [\d.]+ s \(user talked [\d.]+ s\) · transcribed [\d.]+ s/);
    const r2 = await client.callTool({ name: "speak_and_listen", arguments: { text_to_speak: "Anything else?" } });
    assert.equal(r2.content[0].text, "Stub transcript from the server.");

    const log = sb.readLog();
    assert.match(log, /speak "Done. all green. see app.ts."/);
    assert.equal(log.match(/whisper-server start/g)?.length, 1, "the warm server is started once and reused");
    assert.equal(log.match(/whisper-server inference/g)?.length, 2);
    assert.doesNotMatch(log, /whisper-cli/);
  } finally {
    await client.close();
  }
});

test("whisper-cli fallback, with the recording trimmed to the answer", async () => {
  const sb = sandbox();
  fakeModel(path.join(sb.home, ".cache", "mac-voice-mcp", "models"));
  const { client } = await connect(sb.env({ VOICE_MCP_WHISPER_SERVER: "0" }));
  try {
    const r = await client.callTool({ name: "speak_and_listen", arguments: { text_to_speak: "Ready?" } });
    assert.equal(r.content[0].text, "Stub transcript from the CLI.");
    // Stub audio: 1 s noise, 1.5 s speech, 0.6 s pause, 1.2 s speech → ~3.3 s of speech + 2 × 0.3 s padding.
    const seconds = Number(sb.readLog().match(/whisper-cli wav=([\d.]+)s/)[1]);
    assert.ok(seconds > 3.5 && seconds < 4.3, `trimmed wav is ${seconds}s`);
  } finally {
    await client.close();
  }
});

for (const [scenario, expect] of [
  ["silent", { isError: false, match: /No speech detected/ }],
  ["zero", { isError: true, match: /microphone access is blocked/ }],
  ["cough", { isError: false, match: /Stub transcript/ }],
]) {
  test(`listening scenario: ${scenario}`, async () => {
    const sb = sandbox();
    fakeModel(path.join(sb.home, ".cache", "mac-voice-mcp", "models"));
    // Short start timeout keeps the test fast; the cough scenario's answer starts at ~3.2 s.
    const { client } = await connect(sb.env({ STUB_SCENARIO: scenario, VOICE_MCP_START_TIMEOUT_SECONDS: scenario === "cough" ? "5" : "3" }));
    try {
      const r = await client.callTool({ name: "speak_and_listen", arguments: { text_to_speak: "Hello?" } });
      assert.equal(!!r.isError, expect.isError);
      assert.match(text(r), expect.match);
    } finally {
      await client.close();
    }
  });
}

test("talking past listen_seconds is flagged as possibly cut off", async () => {
  const sb = sandbox();
  fakeModel(path.join(sb.home, ".cache", "mac-voice-mcp", "models"));
  const { client } = await connect(sb.env({ STUB_SCENARIO: "long" }));
  try {
    const r = await client.callTool({ name: "speak_and_listen", arguments: { text_to_speak: "Go on.", listen_seconds: 3 } });
    assert.match(text(r), /may be cut off/);
  } finally {
    await client.close();
  }
});

test("setup: check, install only what's missing (with consent), reuse the model, never redo", async () => {
  const sb = sandbox({ installed: false });
  const existing = fakeModel(path.join(sb.dir, "elsewhere")); // the model already exists somewhere else
  const { client } = await connect(sb.env({ VOICE_MCP_MODEL_SEARCH_PATHS: path.dirname(existing) }));
  try {
    // Before setup, speaking points Claude at voice_setup.
    const early = await client.callTool({ name: "speak_and_listen", arguments: { text_to_speak: "hi" } });
    assert.equal(early.isError, true);
    assert.match(text(early), /voice_setup/);

    // Check only: nothing is installed.
    const check = text(await client.callTool({ name: "voice_setup", arguments: {} }));
    assert.match(check, /NOT READY/);
    assert.match(check, /✘ Recorder: .*brew install sox/);
    assert.match(check, /✘ Speech-to-text: .*brew install whisper-cpp/);
    assert.match(check, /✔ Speech model: .*reused/);
    assert.match(check, /ask the user whether to brew install sox whisper-cpp/);
    assert.doesNotMatch(sb.readLog(), /brew install/);

    // With consent: exactly one brew call for exactly the missing formulae; no model download.
    const installed = text(await client.callTool({ name: "voice_setup", arguments: { install: true } }));
    assert.match(installed, /READY/);
    assert.match(installed, /Installed with Homebrew: sox, whisper-cpp/);
    assert.match(sb.readLog(), /^brew install sox whisper-cpp auto_update=1$/m);

    const link = path.join(sb.home, ".cache", "mac-voice-mcp", "models", "ggml-tiny.en.bin");
    assert.ok(lstatSync(link).isSymbolicLink(), "existing model is symlinked, not downloaded");
    assert.equal(readlinkSync(link), existing);

    // Running setup again changes nothing.
    const again = text(await client.callTool({ name: "voice_setup", arguments: { install: true } }));
    assert.match(again, /Nothing to install/);
    assert.equal(sb.readLog().match(/^brew /gm).length, 1);

    // And now it talks.
    const r = await client.callTool({ name: "speak_and_listen", arguments: { text_to_speak: "Set up. Say something." } });
    assert.equal(r.content[0].text, "Stub transcript from the server.");
  } finally {
    await client.close();
  }
});

test("the warm whisper-server never outlives the MCP server, even on a hard kill", { skip: process.platform === "win32" }, async () => {
  const sb = sandbox();
  fakeModel(path.join(sb.home, ".cache", "mac-voice-mcp", "models"));
  const pidFile = path.join(sb.dir, "server.pid");
  const { client, transport } = await connect(sb.env({ STUB_PID_FILE: pidFile }));
  await client.callTool({ name: "speak_and_listen", arguments: { text_to_speak: "hi" } });
  const serverPid = Number(readFileSync(pidFile, "utf8"));
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(alive(serverPid), "whisper-server is running");

  process.kill(transport.pid, "SIGKILL"); // no chance to clean up
  const deadline = Date.now() + 5000;
  while (alive(serverPid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.ok(!alive(serverPid), "whisper-server exits when its parent dies");
  await client.close().catch(() => {});
});

test("setup reuses a whisper.cpp built from source that isn't on PATH", async () => {
  const sb = sandbox({ installed: false });
  const buildDir = path.join(sb.home, "whisper.cpp", "build", "bin");
  mkdirSync(buildDir, { recursive: true });
  for (const bin of ["whisper-cli", "whisper-server"]) symlinkSync(path.join(FIXTURES, "installable", bin), path.join(buildDir, bin));
  symlinkSync(path.join(FIXTURES, "installable", "rec"), path.join(sb.dir, "brew-bin", "rec")); // SoX already installed
  fakeModel(path.join(sb.home, "whisper.cpp", "models")); // …and its model
  const { client } = await connect(sb.env());
  try {
    const check = text(await client.callTool({ name: "voice_setup", arguments: {} }));
    assert.match(check, /READY/);
    assert.match(check, new RegExp(`Speech-to-text: whisper.cpp — whisper-cli \\(${buildDir.replace(/[/.]/g, "\\$&")}`));
    assert.match(check, /fast mode via whisper-server/);
    assert.match(check, /Speech model: .*reused/);
    const r = await client.callTool({ name: "speak_and_listen", arguments: { text_to_speak: "hi" } });
    assert.equal(r.content[0].text, "Stub transcript from the server.");
    assert.doesNotMatch(sb.readLog(), /^brew /m);
  } finally {
    await client.close();
  }
});

// --- One voice turn at a time across sessions, and speaking without listening ----------------

/** The kinds of audio events in the stub log, in order: speak / rec / transcribe. */
const audioEvents = (log) =>
  log
    .split("\n")
    .map((l) => (l.startsWith("speak ") ? "speak" : l.startsWith("rec ") ? "rec" : /whisper-server inference/.test(l) ? "transcribe" : null))
    .filter(Boolean);

test("two sessions on one Mac take turns at the mic instead of talking over each other", async () => {
  const sb = sandbox();
  fakeModel(path.join(sb.home, ".cache", "mac-voice-mcp", "models"));
  const a = await connect(sb.env());
  const b = await connect(sb.env());
  try {
    const [ra, rb] = await Promise.all([
      a.client.callTool({ name: "speak_and_listen", arguments: { text_to_speak: "From session A." } }),
      b.client.callTool({ name: "speak_and_listen", arguments: { text_to_speak: "From session B." } }),
    ]);
    assert.equal(ra.isError, false);
    assert.equal(rb.isError, false);
    assert.deepEqual(audioEvents(sb.readLog()), ["speak", "rec", "transcribe", "speak", "rec", "transcribe"]);
    assert.ok(!existsSync(path.join(sb.home, ".cache", "mac-voice-mcp", "mic.lock")), "the lock is released after the turns");
  } finally {
    await a.client.close();
    await b.client.close();
  }
});

test("a lock left behind by a crashed session is taken over", async () => {
  const sb = sandbox();
  const cache = path.join(sb.home, ".cache", "mac-voice-mcp");
  fakeModel(path.join(cache, "models"));
  writeFileSync(path.join(cache, "mic.lock"), JSON.stringify({ pid: 2 ** 22 + 12345, since: Date.now() })); // no such process
  const { client } = await connect(sb.env({ VOICE_MCP_LOCK_WAIT_SECONDS: "2" }));
  try {
    const r = await client.callTool({ name: "speak_and_listen", arguments: { text_to_speak: "Hello?" } });
    assert.equal(r.isError, false);
    assert.equal(r.content[0].text, "Stub transcript from the server.");
  } finally {
    await client.close();
  }
});

test("a session that keeps the mic busy makes the next one give up with a clear message", async () => {
  const sb = sandbox();
  const cache = path.join(sb.home, ".cache", "mac-voice-mcp");
  fakeModel(path.join(cache, "models"));
  writeFileSync(path.join(cache, "mic.lock"), JSON.stringify({ pid: process.pid, since: Date.now() })); // alive: this test runner
  const { client } = await connect(sb.env({ VOICE_MCP_LOCK_WAIT_SECONDS: "1" }));
  try {
    const r = await client.callTool({ name: "speak_and_listen", arguments: { text_to_speak: "Hello?" } });
    assert.equal(r.isError, true);
    assert.match(text(r), /Another voice session on this Mac/);
    assert.deepEqual(audioEvents(sb.readLog()), [], "nothing was spoken or recorded");
  } finally {
    await client.close();
  }
});

test("listen: false speaks without opening the mic, and needs no speech-to-text setup", async () => {
  const sb = sandbox({ installed: false }); // no recorder, no whisper, no model
  const { client } = await connect(sb.env());
  try {
    const r = await client.callTool({ name: "speak_and_listen", arguments: { text_to_speak: "Voice mode is off. Talk soon!", listen: false } });
    assert.equal(r.isError, false);
    assert.match(r.content[0].text, /microphone was not opened/);
    assert.match(text(r), /voice-mcp timing: spoke [\d.]+ s/);
    assert.deepEqual(audioEvents(sb.readLog()), ["speak"]);
  } finally {
    await client.close();
  }
});

// --- Recorder: SoX preferred, ffmpeg only as a fallback that follows the chosen input -------------

test("setup notices tools installed outside it (e.g. brew install sox in a terminal) without a restart", async () => {
  const sb = sandbox({ installed: false });
  for (const bin of ["whisper-cli", "whisper-server"]) symlinkSync(path.join(FIXTURES, "installable", bin), path.join(sb.dir, "brew-bin", bin));
  fakeModel(path.join(sb.home, ".cache", "mac-voice-mcp", "models"));
  const { client } = await connect(sb.env());
  try {
    assert.match(text(await client.callTool({ name: "voice_setup", arguments: {} })), /✘ Recorder/);
    symlinkSync(path.join(FIXTURES, "installable", "rec"), path.join(sb.dir, "brew-bin", "rec")); // installed by hand
    const again = text(await client.callTool({ name: "voice_setup", arguments: {} }));
    assert.match(again, /✔ Recorder: SoX/);
    assert.match(again, /READY/);
  } finally {
    await client.close();
  }
});

/** A stub ffmpeg that logs its arguments and streams the stub recorder's audio (STUB_SCENARIO). */
function addFfmpegStub(sb) {
  const file = path.join(sb.dir, "brew-bin", "ffmpeg");
  writeFileSync(
    file,
    [
      "#!/usr/bin/env node",
      'require("fs").appendFileSync(process.env.STUB_LOG, `ffmpeg ${process.argv.slice(2).join(" ")}\\n`);',
      `require(${JSON.stringify(path.join(FIXTURES, "installable", "rec"))});`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

test("ffmpeg-only Macs: setup recommends SoX, installs it with consent, and ffmpeg follows the default input", { skip: process.platform !== "darwin" && "the ffmpeg fallback is macOS-only" }, async () => {
  const sb = sandbox({ installed: false });
  for (const bin of ["whisper-cli", "whisper-server"]) symlinkSync(path.join(FIXTURES, "installable", bin), path.join(sb.dir, "brew-bin", bin));
  fakeModel(path.join(sb.home, ".cache", "mac-voice-mcp", "models"));
  addFfmpegStub(sb);
  const { client } = await connect(sb.env({ VOICE_MCP_RECORDER: "auto" }));
  try {
    const check = text(await client.callTool({ name: "voice_setup", arguments: {} }));
    assert.match(check, /READY/);
    assert.match(check, /• Recorder: ffmpeg .*fallback.*→ brew install sox/);
    assert.match(check, /Recommended: ask the user whether to brew install sox/);

    const r = await client.callTool({ name: "speak_and_listen", arguments: { text_to_speak: "Hi" } });
    assert.equal(r.isError, false);
    assert.match(sb.readLog(), /^ffmpeg .*-f avfoundation -i :default /m, "records from the system's chosen input, not device 0");

    const installed = text(await client.callTool({ name: "voice_setup", arguments: { install: true } }));
    assert.match(sb.readLog(), /^brew install sox auto_update=1$/m);
    assert.match(installed, /✔ Recorder: SoX/);
  } finally {
    await client.close();
  }
});

test("silence through ffmpeg blames the device and suggests SoX, not just permissions", { skip: process.platform !== "darwin" && "the ffmpeg fallback is macOS-only" }, async () => {
  const sb = sandbox({ installed: false });
  for (const bin of ["whisper-cli", "whisper-server"]) symlinkSync(path.join(FIXTURES, "installable", bin), path.join(sb.dir, "brew-bin", bin));
  fakeModel(path.join(sb.home, ".cache", "mac-voice-mcp", "models"));
  addFfmpegStub(sb);
  const { client } = await connect(sb.env({ VOICE_MCP_RECORDER: "auto", STUB_SCENARIO: "zero", VOICE_MCP_START_TIMEOUT_SECONDS: "3" }));
  try {
    const r = await client.callTool({ name: "speak_and_listen", arguments: { text_to_speak: "Hello?" } });
    assert.equal(r.isError, true);
    assert.match(text(r), /^The microphone returned pure digital silence\. voice-mcp is recording with ffmpeg/);
    assert.match(text(r), /brew install sox/);
  } finally {
    await client.close();
  }
});
