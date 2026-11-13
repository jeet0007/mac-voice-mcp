/**
 * The mic's sounds and the spoken errors (docs/specs/voice-cues.md), with fake afplay and say first
 * on PATH: they record their arguments and play nothing. The tones need macOS's system sounds
 * (afplay, /System/Library/Sounds), so those tests run on a Mac only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "test", "fixtures");
const ENTRY = path.join(ROOT, "dist", "index.js");
const MAC = { skip: process.platform !== "darwin" && "the tones are macOS system sounds played with afplay" };

function sandbox({ tools = ["rec", "whisper-cli", "whisper-server"] } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "voice-mcp-cues-"));
  const home = path.join(dir, "home");
  const bin = path.join(dir, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const t of tools) symlinkSync(path.join(FIXTURES, "installable", t), path.join(bin, t));
  const log = path.join(dir, "log.txt");
  writeFileSync(log, "");
  const cache = path.join(home, ".cache", "mac-voice-mcp");
  return {
    dir,
    home,
    cache,
    log,
    readLog: () => readFileSync(log, "utf8"),
    /** The sounds and spoken lines, in order. */
    events: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .flatMap((l) => {
          const tone = l.match(/^afplay -v ([\d.]+) \/System\/Library\/Sounds\/(\w+)\.aiff$/);
          if (tone) return [`${tone[2]} ${tone[1]}`];
          const said = l.match(/^speak (".*")$/);
          if (said) return [`say ${JSON.parse(said[1])}`];
          if (l === "rec stopped") return ["rec stopped"];
          return [];
        }),
    env: (extra = {}) => ({
      HOME: home,
      PATH: [path.join(FIXTURES, "bin"), bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
      STUB_LOG: log,
      VOICE_MCP_WHISPER_MODEL: "tiny.en",
      VOICE_MCP_RECORDER: "sox",
      VOICE_MCP_VOICE_STANDBY: "0",
      VOICE_MCP_EXTRA_PATH: "",
      ...extra,
    }),
  };
}

function fakeModel(cache) {
  const dir = path.join(cache, "models");
  mkdirSync(dir, { recursive: true });
  const buf = Buffer.alloc(1_100_000);
  buf.writeUInt32LE(0x67676d6c, 0);
  writeFileSync(path.join(dir, "ggml-tiny.en.bin"), buf);
}

async function connect(env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY], env, stderr: "pipe" });
  const client = new Client({ name: "cues", version: "0" });
  await client.connect(transport);
  return client;
}
const text = (r) => r.content.map((c) => c.text).join("\n");

/** Run `script` (async, top-level await) against dist/cues.js with the sandbox's fake afplay and say. */
function inServer(sb, script, env = {}) {
  const r = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `const cues = await import(${JSON.stringify(path.join(ROOT, "dist", "cues.js"))});\n${script}`],
    { env: sb.env(env), encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const LINES = {
  silence: "I only hear silence. Please allow microphone access for this app.",
  "no-recorder": "I can't record yet. Please check the screen for setup.",
  "no-whisper": "I can't understand speech yet. Please check the screen for setup.",
  "no-model": "My speech model is missing. Please check the screen for setup.",
  "model-downloading": "My speech model is still downloading. Try again in a minute.",
};

test("each cue plays its own system sound at its own volume", MAC, () => {
  const sb = sandbox();
  inServer(sb, `for (const c of ["open", "close", "no-speech", "error"]) await cues.cue(c);`);
  assert.deepEqual(sb.events(), ["Tink 0.6", "Pop 0.5", "Purr 0.45", "Basso 0.6"]);
});

test("every spoken line is 12 words or fewer, plain letters only, and the five kinds are exactly the spec's", () => {
  const sb = sandbox();
  const out = JSON.parse(inServer(sb, `console.log(JSON.stringify(cues.SPOKEN_ERRORS))`));
  assert.deepEqual(out, LINES);
  for (const [kind, line] of Object.entries(out)) {
    assert.ok(line.split(/\s+/).length <= 12, `${kind}: ${line}`);
    assert.match(line, /^[A-Za-z' .,]+$/, kind);
  }
  assert.ok(!("mic-busy" in out), "a busy mic is never spoken: our voice would be taken as the other window's user");
});

test("each failure: Basso at 0.6, then its exact line", MAC, () => {
  for (const [kind, line] of Object.entries(LINES)) {
    const sb = sandbox();
    inServer(sb, `console.log(JSON.stringify(await cues.announceError(${JSON.stringify(kind)})))`);
    assert.deepEqual(sb.events(), ["Basso 0.6", `say ${line}`], kind);
  }
});

test("the same failure within 10 minutes is the tone only; after 10 minutes it is spoken again (fake clock)", MAC, () => {
  const sb = sandbox();
  const out = inServer(
    sb,
    `
    const t0 = 1_000_000;
    const r = [];
    r.push(await cues.announceError("silence", { now: t0 }));
    r.push(await cues.announceError("silence", { now: t0 + 9 * 60_000 }));
    r.push(await cues.announceError("no-recorder", { now: t0 + 9 * 60_000 })); // another kind: spoken
    r.push(await cues.announceError("silence", { now: t0 + 10 * 60_000 }));
    console.log(JSON.stringify(r.map((a) => [a.spoken, a.repeat])));`,
  );
  assert.deepEqual(JSON.parse(out), [[true, false], [false, true], [true, false], [true, false]]);
  assert.deepEqual(sb.events(), [
    "Basso 0.6", `say ${LINES.silence}`,
    "Basso 0.6",
    "Basso 0.6", `say ${LINES["no-recorder"]}`,
    "Basso 0.6", `say ${LINES.silence}`,
  ]);
});

test("VOICE_MCP_CHIME=0 plays no tone but still speaks; VOICE_MCP_SPOKEN_ERRORS=0 says nothing but still plays the tone", MAC, () => {
  const quiet = sandbox();
  inServer(quiet, `for (const c of ["open", "close", "no-speech", "error"]) await cues.cue(c); await cues.announceError("silence");`, { VOICE_MCP_CHIME: "0" });
  assert.deepEqual(quiet.events(), [`say ${LINES.silence}`]);
  assert.doesNotMatch(quiet.readLog(), /afplay/);

  const mute = sandbox();
  inServer(mute, `await cues.announceError("silence");`, { VOICE_MCP_SPOKEN_ERRORS: "0" });
  assert.deepEqual(mute.events(), ["Basso 0.6"]);
  assert.doesNotMatch(mute.readLog(), /^speak /m);
});

test("if the built-in voice fails, the tone is all there is, and the failure is not counted as spoken", MAC, () => {
  const sb = sandbox();
  const out = inServer(sb, `console.log(JSON.stringify(await cues.announceError("silence")))`, { STUB_SAY_FAIL: "1" });
  assert.equal(JSON.parse(out).spoken, false);
  assert.deepEqual(sb.events().slice(0, 1), ["Basso 0.6"]);
});

test("the notes for Claude: spoken now, tone only inside the window, nothing when no line was said", () => {
  const sb = sandbox();
  const out = JSON.parse(
    inServer(
      sb,
      `console.log(JSON.stringify([
        cues.errorNote({ spoken: true, line: "L", repeat: false }),
        cues.errorNote({ spoken: false, line: "L", repeat: true }),
        cues.errorNote({ spoken: false, line: "L", repeat: false }),
      ]))`,
    ),
  );
  assert.match(out[0], /^voice-mcp note: the user already heard this out loud \("L"\)\. Do not say it again by voice, and do not call speak_and_listen again until it is fixed\. Explain the fix on screen\.$/);
  assert.match(out[1], /^voice-mcp note: the user heard an error tone, and the spoken explanation earlier\. /);
  assert.equal(out[2], null);
});

// --- Through the real server -------------------------------------------------------------------

test("mic open: Tink; silence in the room: Purr, no Pop", MAC, async () => {
  const sb = sandbox();
  fakeModel(sb.cache);
  const client = await connect(sb.env({ STUB_SCENARIO: "silent", VOICE_MCP_START_TIMEOUT_SECONDS: "2" }));
  try {
    const r = await client.callTool({ name: "speak_and_listen", arguments: { text_to_speak: "Hello?" } });
    assert.match(text(r), /No speech detected/);
    await new Promise((res) => setTimeout(res, 300)); // the purr plays in the background
    assert.deepEqual(sb.events().filter((e) => !e.startsWith("say")), ["Tink 0.6", "rec stopped", "Purr 0.45"]);
  } finally {
    await client.close();
  }
});

test("words heard: Pop at 0.5 and no Purr", MAC, async () => {
  const sb = sandbox();
  fakeModel(sb.cache);
  const client = await connect(sb.env());
  try {
    const r = await client.callTool({ name: "speak_and_listen", arguments: { text_to_speak: "Ready?" } });
    assert.equal(r.content[0].text, "Stub transcript from the server.");
    await new Promise((res) => setTimeout(res, 300));
    assert.deepEqual(sb.events().filter((e) => !e.startsWith("say")), ["Tink 0.6", "rec stopped", "Pop 0.5"]);
  } finally {
    await client.close();
  }
});

test("a sound but no words: Pop at once, then Purr", MAC, async () => {
  const sb = sandbox();
  fakeModel(sb.cache);
  const client = await connect(sb.env({ STUB_TRANSCRIPT: "[gunshot]" }));
  try {
    const r = await client.callTool({ name: "speak_and_listen", arguments: { text_to_speak: "Ready?" } });
    assert.match(text(r), /picked up a sound but no words/);
    await new Promise((res) => setTimeout(res, 600));
    assert.deepEqual(sb.events().filter((e) => !e.startsWith("say")), ["Tink 0.6", "rec stopped", "Pop 0.5", "Purr 0.45"]);
  } finally {
    await client.close();
  }
});

test("digital silence: no Pop; after the recorder stops, Basso, then the line; the text and a note reach Claude; the repeat is tone only", MAC, async () => {
  const sb = sandbox();
  fakeModel(sb.cache);
  const client = await connect(sb.env({ STUB_SCENARIO: "zero", VOICE_MCP_START_TIMEOUT_SECONDS: "2" }));
  try {
    const r1 = await client.callTool({ name: "speak_and_listen", arguments: { text_to_speak: "Hello?" } });
    assert.equal(r1.isError, true);
    assert.match(text(r1), /microphone access is blocked/); // today's text stays
    assert.match(text(r1), new RegExp(`voice-mcp note: the user already heard this out loud \\("${LINES.silence}"\\)`));
    const lineOf = (e) => e.filter((x) => !x.startsWith("say Hello"));
    assert.deepEqual(lineOf(sb.events()), ["Tink 0.6", "rec stopped", "Basso 0.6", `say ${LINES.silence}`], "the mic is closed before the tone and the line");

    const r2 = await client.callTool({ name: "speak_and_listen", arguments: { text_to_speak: "Again?" } });
    assert.match(text(r2), /voice-mcp note: the user heard an error tone, and the spoken explanation earlier/);
    const spokenLines = sb.events().filter((e) => e === `say ${LINES.silence}`);
    assert.equal(spokenLines.length, 1, "spoken once");
    assert.equal(sb.events().filter((e) => e === "Basso 0.6").length, 2, "the tone both times");
  } finally {
    await client.close();
  }
});

for (const [name, tools, withModel, kind] of [
  ["no recorder", ["whisper-cli", "whisper-server"], true, "no-recorder"],
  ["no whisper", ["rec"], true, "no-whisper"],
  ["no model", ["rec", "whisper-cli", "whisper-server"], false, "no-model"],
]) {
  test(`setup failure (${name}): Basso and the line, Claude's text not spoken, a note for Claude`, MAC, async () => {
    const sb = sandbox({ tools });
    if (withModel) fakeModel(sb.cache);
    const client = await connect(sb.env());
    try {
      const r = await client.callTool({ name: "speak_and_listen", arguments: { text_to_speak: "Hello there?" } });
      assert.equal(r.isError, true);
      assert.match(text(r), /voice-mcp is not set up yet/);
      assert.match(text(r), /voice-mcp note: the user already heard this out loud/);
      assert.deepEqual(sb.events(), ["Basso 0.6", `say ${LINES[kind]}`]);
    } finally {
      await client.close();
    }
  });
}

test("model still downloading: that line, not 'missing'", MAC, async () => {
  const { createServer: probe } = await import("node:net");
  const port = await new Promise((res) => {
    const s = probe().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
  const sb = sandbox();
  // One process: a never-ending local download is running (as voice_setup would start), and a turn's preflight sees it.
  const out = inServer(
    sb,
    `
    const { createServer } = await import("node:http");
    const http = createServer((_req, res) => {
      res.writeHead(200, { "content-length": "100000000" });
      res.write(Buffer.alloc(10));
    });
    await new Promise((r) => http.listen(${port}, "127.0.0.1", r));
    const model = await import(${JSON.stringify(path.join(ROOT, "dist", "model.js"))});
    const voice = await import(${JSON.stringify(path.join(ROOT, "dist", "voice.js"))});
    model.ensureModel({ download: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    let err;
    try { await voice.preflight(); } catch (e) { err = e; }
    console.log(JSON.stringify({ downloading: model.isModelDownloading(), note: err?.voiceNote ?? null }));
    process.exit(0);`,
    { VOICE_MCP_MODEL_BASE_URL: `http://127.0.0.1:${port}` },
  );
  const got = JSON.parse(out.trim().split("\n").pop());
  assert.equal(got.downloading, true);
  assert.match(got.note, /already heard this out loud \("My speech model is still downloading\. Try again in a minute\."\)/);
  assert.deepEqual(sb.events(), ["Basso 0.6", `say ${LINES["model-downloading"]}`]);
});

test("a busy mic is text only: no tone and no spoken line", MAC, async () => {
  const sb = sandbox();
  fakeModel(sb.cache);
  writeFileSync(path.join(sb.cache, "mic.lock"), JSON.stringify({ pid: process.pid, since: Date.now() }));
  const client = await connect(sb.env({ VOICE_MCP_LOCK_WAIT_SECONDS: "1" }));
  try {
    const r = await client.callTool({ name: "speak_and_listen", arguments: { text_to_speak: "Hello?" } });
    assert.equal(r.isError, true);
    assert.match(text(r), /Another voice session on this Mac/);
    assert.doesNotMatch(text(r), /already heard/);
    assert.deepEqual(sb.events(), []);
    assert.doesNotMatch(sb.readLog(), /afplay|tts-start/);
  } finally {
    await client.close();
  }
});

test("voice_setup: the microphone and sounds lines; the ready line is spoken once, after an install run only", MAC, async () => {
  const plain = sandbox();
  fakeModel(plain.cache);
  const c1 = await connect(plain.env());
  try {
    const r = await c1.callTool({ name: "voice_setup", arguments: {} });
    assert.match(text(r), /READY/);
    assert.match(text(r), /• Microphone: the first time it listens, macOS asks to allow microphone access for this app \(Terminal, Claude, Cursor …\)\. Click Allow\./);
    assert.match(text(r), /• Sounds: a soft tick means the mic is open, a pop means it heard you, a low purr means it heard nothing, a low thud means something is wrong \(it also says what\)\./);
    assert.match(text(r), /speak_and_listen is ready to use\. Tell the user once, in one sentence, what the tick means\./);
    await new Promise((res) => setTimeout(res, 300));
    assert.doesNotMatch(plain.readLog(), /^speak /m, "a plain check never speaks");
  } finally {
    await c1.close();
  }

  const installed = sandbox();
  fakeModel(installed.cache);
  const c2 = await connect(installed.env());
  try {
    await c2.callTool({ name: "voice_setup", arguments: { install: true } });
    await c2.callTool({ name: "voice_setup", arguments: { install: true } });
    await new Promise((res) => setTimeout(res, 500));
    const said = installed.events().filter((e) => e.startsWith("say "));
    assert.deepEqual(said, ["say Voice is ready. You'll hear a tick when I'm listening."], "once per server process");
  } finally {
    await c2.close();
  }

  const off = sandbox();
  fakeModel(off.cache);
  const c3 = await connect(off.env({ VOICE_MCP_SPOKEN_ERRORS: "0" }));
  try {
    await c3.callTool({ name: "voice_setup", arguments: { install: true } });
    await new Promise((res) => setTimeout(res, 300));
    assert.doesNotMatch(off.readLog(), /^speak /m);
  } finally {
    await c3.close();
  }
});

test("the server instructions carry the one-line rule and stay under 2 KB", async () => {
  const sb = sandbox();
  const client = await connect(sb.env());
  try {
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /voice-mcp note/);
    assert.match(instructions.replace(/\s+/g, " "), /already heard an error means: explain on screen, don't retry by voice/);
    assert.ok(Buffer.byteLength(instructions) < 2048, `${Buffer.byteLength(instructions)} bytes`);
  } finally {
    await client.close();
  }
});
