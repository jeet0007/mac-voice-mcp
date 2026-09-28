// The Claude Code plugin hook that keeps a voice conversation in voice (hooks/voice-mode*.mjs).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { handle, heardUser, NOT_HEARD_PREFIXES, STOP_REASON } from "../hooks/voice-mode-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "hooks", "voice-mode.mjs");
const TOOL = "mcp__plugin_mac-voice-mcp_voice-mcp__speak_and_listen";
const reply = (text) => ({ content: [{ type: "text", text }] });
const heard = reply("Yes, go ahead and deploy it.");

function setup() {
  const env = { VOICE_MCP_CACHE_DIR: mkdtempSync(path.join(os.tmpdir(), "voice-hook-")) };
  const run = (event, extra = {}, now = Date.now()) => handle({ session_id: "s1", hook_event_name: event, ...extra }, { env, now });
  const spoke = (response = heard, input = { text_to_speak: "Deploy?" }, now) =>
    run("PostToolUse", { tool_name: TOOL, tool_input: input, tool_response: response }, now);
  return { env, run, spoke };
}

test("does nothing until the user actually talks by voice", () => {
  const { run } = setup();
  assert.deepEqual(run("Stop"), { exitCode: 0 });
});

test("after a spoken answer, a text-only stop is sent back once — then allowed until the next answer", () => {
  const { run, spoke } = setup();
  spoke();
  assert.deepEqual(run("Stop"), { exitCode: 2, stderr: STOP_REASON });
  assert.deepEqual(run("Stop"), { exitCode: 0 }, "no second nudge for the same answer, even without stop_hook_active");
  spoke();
  assert.equal(run("Stop").exitCode, 2, "a new spoken answer re-arms it");
  assert.deepEqual(run("Stop", { stop_hook_active: true }), { exitCode: 0 });
});

test("typing, or the session ending, ends voice mode", () => {
  for (const event of ["UserPromptSubmit", "SessionEnd"]) {
    const { run, spoke } = setup();
    spoke();
    run(event, { prompt: "ok I'm back" });
    assert.deepEqual(run("Stop"), { exitCode: 0 }, event);
  }
});

test("listen:false, no answer, or a failed call ends voice mode", () => {
  for (const [input, response] of [
    [{ text_to_speak: "Bye!", listen: false }, reply("(Spoken. The microphone was not opened, because listen was false.)")],
    [{ text_to_speak: "Still there?" }, reply("(No speech detected — the user did not reply within 15 seconds. The microphone is now off.)")],
    [{ text_to_speak: "Hi" }, { content: [{ type: "text", text: "voice-mcp is not set up yet: …" }], isError: true }],
    [{ text_to_speak: "Hi" }, [{ type: "text", text: "Another voice session on this Mac (another Claude window, Claude Desktop or Cursor) has been using the speaker" }]],
  ]) {
    const { run, spoke } = setup();
    spoke();
    spoke(response, input);
    assert.deepEqual(run("Stop"), { exitCode: 0 }, JSON.stringify(response));
  }
  const { run, spoke } = setup();
  spoke();
  run("PostToolUseFailure", { tool_name: TOOL, tool_input: {}, error: "MCP error" });
  assert.deepEqual(run("Stop"), { exitCode: 0 }, "PostToolUseFailure");
});

test("other tools don't change voice mode", () => {
  const { run, spoke } = setup();
  spoke();
  run("PostToolUse", { tool_name: "Bash", tool_input: {}, tool_response: reply("(No speech detected") });
  run("PostToolUseFailure", { tool_name: "Bash", tool_input: {} });
  assert.equal(run("Stop").exitCode, 2);
});

test("the user saying a trigger phrase doesn't end voice mode — only how the result starts counts", () => {
  for (const said of ["The database is not set up yet, can you check?", "I got a voice-mcp error: earlier", "Another voice session? No."]) {
    assert.equal(heardUser({}, reply(said)), true, said);
  }
  for (const p of NOT_HEARD_PREFIXES) assert.equal(heardUser({}, reply(`${p} …`)), false, p);
  assert.equal(heardUser({}, "Sure."), true);
  assert.equal(heardUser({}, { content: [{ type: "text", text: "Sure." }], isError: true }), false);
  assert.equal(heardUser({}, { unexpected: "shape" }), false, "unknown shapes never switch voice mode on");
});

test("the hook's prefixes match what the server actually says", () => {
  const src = ["src/voice.ts", "src/lock.ts", "src/server.ts"].map((f) => readFileSync(path.join(ROOT, f), "utf8")).join("\n");
  for (const p of NOT_HEARD_PREFIXES) assert.ok(src.includes(p), `server source no longer contains: ${p}`);
});

test("voice mode expires after 30 idle minutes, and sessions don't affect each other", () => {
  const { env, run, spoke } = setup();
  const t = Date.now();
  spoke(heard, undefined, t);
  assert.equal(handle({ session_id: "other", hook_event_name: "Stop" }, { env }).exitCode, 0);
  assert.equal(run("Stop", {}, t + 31 * 60_000).exitCode, 0);
  spoke(heard, undefined, t);
  assert.equal(run("Stop", {}, t + 29 * 60_000).exitCode, 2);
});

test("VOICE_MCP_STAY_IN_VOICE=0 turns the hook off", () => {
  const { env, spoke } = setup();
  spoke();
  assert.equal(handle({ session_id: "s1", hook_event_name: "Stop" }, { env: { ...env, VOICE_MCP_STAY_IN_VOICE: "0" } }).exitCode, 0);
});

test("as a real process — also through a symlinked install path — and bad input never blocks", () => {
  const linked = path.join(mkdtempSync(path.join(os.tmpdir(), "voice-hook-link-")), "plugin");
  const copy = mkdtempSync(path.join(os.tmpdir(), "voice-hook-copy-"));
  cpSync(path.join(ROOT, "hooks"), path.join(copy, "hooks"), { recursive: true });
  symlinkSync(copy, linked);
  for (const hook of [HOOK, path.join(linked, "hooks", "voice-mode.mjs")]) {
    const env = { ...process.env, VOICE_MCP_CACHE_DIR: mkdtempSync(path.join(os.tmpdir(), "voice-hook-")) };
    const call = (input) => spawnSync(process.execPath, [hook], { input, env, encoding: "utf8" });
    call(JSON.stringify({ session_id: "p1", hook_event_name: "PostToolUse", tool_name: TOOL, tool_input: {}, tool_response: heard }));
    const stop = call(JSON.stringify({ session_id: "p1", hook_event_name: "Stop", stop_hook_active: false }));
    assert.equal(stop.status, 2, hook);
    assert.match(stop.stderr, /speak_and_listen/);
    assert.equal(call("not json").status, 0);
    assert.equal(call("").status, 0);
  }
});

test("hooks.json runs the hook for the right events and matches the tool under any server scope", () => {
  const cfg = JSON.parse(readFileSync(path.join(ROOT, "hooks", "hooks.json"), "utf8"));
  assert.deepEqual(Object.keys(cfg.hooks).sort(), ["PostToolUse", "PostToolUseFailure", "SessionEnd", "Stop", "UserPromptSubmit"]);
  for (const groups of Object.values(cfg.hooks)) {
    for (const g of groups) for (const h of g.hooks) assert.equal(h.command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/voice-mode.mjs"');
  }
  for (const event of ["PostToolUse", "PostToolUseFailure"]) {
    const matcher = new RegExp(`^(?:${cfg.hooks[event][0].matcher})$`);
    assert.match(TOOL, matcher);
    assert.match("mcp__voice-mcp__speak_and_listen", matcher);
    assert.doesNotMatch("mcp__plugin_mac-voice-mcp_voice-mcp__voice_setup", matcher);
  }
});
