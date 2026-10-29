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
const CALL_TOOL = "mcp__plugin_mac-voice-mcp_voice-mcp__call";
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
    [{ text_to_speak: "Bye!", listen: false }, reply("(Speaking in the background, so you can carry on working. The microphone was not opened, because listen was false.)")],
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
  const src = ["src/voice.ts", "src/lock.ts", "src/server.ts", "src/texts.ts"].map((f) => readFileSync(path.join(ROOT, f), "utf8")).join("\n");
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

test("hooks.json: speak_and_listen updates voice mode under any server scope; every other tool only runs the cheap check", () => {
  const cfg = JSON.parse(readFileSync(path.join(ROOT, "hooks", "hooks.json"), "utf8"));
  assert.deepEqual(Object.keys(cfg.hooks).sort(), ["PostToolUse", "PostToolUseFailure", "SessionEnd", "Stop", "UserPromptSubmit"]);
  const NODE = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/voice-mode.mjs"';
  for (const [event, groups] of Object.entries(cfg.hooks)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        if (event === "PostToolUse" && g.matcher === undefined) assert.equal(h.command, 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/after-tool.sh"');
        else assert.equal(h.command, NODE);
      }
    }
  }
  // speak_and_listen and call (under any server scope) update voice mode; every other tool only runs the cheap inbox check.
  for (const g of [cfg.hooks.PostToolUse[0], cfg.hooks.PostToolUseFailure[0]]) {
    const matcher = new RegExp(`^(?:${g.matcher})$`);
    assert.match(TOOL, matcher);
    assert.match(CALL_TOOL, matcher);
    assert.match("mcp__voice-mcp__speak_and_listen", matcher);
    assert.doesNotMatch("mcp__plugin_mac-voice-mcp_voice-mcp__voice_setup", matcher);
    assert.doesNotMatch("mcp__plugin_mac-voice-mcp_voice-mcp__say", matcher);
  }
  assert.equal(cfg.hooks.PostToolUse[1].matcher, undefined, "the inbox check runs after every tool");
});

test("after every tool, the shell check exits at once with nothing said, and hands over what was said", () => {
  const { env, spoke } = setup();
  const script = path.join(ROOT, "hooks", "after-tool.sh");
  const event = JSON.stringify({ session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {}, tool_response: "ok" });
  const runSh = () => spawnSync("sh", [script], { input: event, env: { ...process.env, ...env }, encoding: "utf8" });
  spoke();
  let r = runSh();
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
  leaveInInbox(env, "use the other branch");
  r = runSh();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /the user said by voice: "use the other branch"/);
});

// --- Talking while Claude works --------------------------------------------------------------

import { writeFileSync as writeFileSyncW, mkdirSync as mkdirSyncW, existsSync as existsSyncW } from "node:fs";

function leaveInInbox(env, text, at = Date.now()) {
  const inbox = path.join(env.VOICE_MCP_CACHE_DIR, "voice-mode", "inbox");
  mkdirSyncW(inbox, { recursive: true });
  writeFileSyncW(path.join(inbox, `${at}-x${Math.random().toString(36).slice(2, 6)}.json`), JSON.stringify({ text, at }));
}

test("a spoken answer marks this session as listening; typing removes the mark", () => {
  const { env, run, spoke } = setup();
  const mark = path.join(env.VOICE_MCP_CACHE_DIR, "voice-mode", "listening.state");
  spoke();
  assert.equal(JSON.parse(readFileSync(mark, "utf8")).session, "s1");
  run("UserPromptSubmit");
  assert.equal(existsSyncW(mark), false);
  spoke();
  spoke(reply("(No speech detected — the user did not reply within 15 seconds.)"));
  assert.equal(existsSyncW(mark), false, "no answer ends listening too");
});

test("what the user said while Claude worked is handed over after its next tool call, once", () => {
  const { env, run, spoke } = setup();
  spoke();
  leaveInInbox(env, "use the other branch");
  const r = run("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "ok" });
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /While you were working, the user said by voice: "use the other branch"/);
  assert.deepEqual(run("PostToolUse", { tool_name: "Bash", tool_input: {}, tool_response: "ok" }), { exitCode: 0 }, "delivered once");
});

test("a subagent's tool calls leave what the user said for the main Claude", () => {
  const { env, run, spoke } = setup();
  spoke();
  leaveInInbox(env, "use the other branch");
  const sub = run("PostToolUse", { tool_name: "Bash", tool_input: {}, tool_response: "ok", agent_id: "a1", agent_type: "fork" });
  assert.deepEqual(sub, { exitCode: 0 });
  assert.equal(run("PostToolUse", { tool_name: "Bash", tool_input: {}, tool_response: "ok" }).exitCode, 2, "main Claude gets it");
});

test("another session's interjections stay put, and Stop delivers them even after the one nudge", () => {
  const { env, run, spoke } = setup();
  spoke();
  leaveInInbox(env, "skip the slow tests");
  const other = handle({ session_id: "s2", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {}, tool_response: "ok" }, { env });
  assert.deepEqual(other, { exitCode: 0 }, "not the session that's listening");
  assert.equal(run("Stop").exitCode, 2, "first stop: the interjection");
  assert.match(run("Stop").stderr ?? "", /speak_and_listen/, "then the usual voice-mode nudge");
});

test("VOICE_MCP_STAY_IN_VOICE=0 turns off the nudges but still hands over what the user said", () => {
  const env = { VOICE_MCP_CACHE_DIR: mkdtempSync(path.join(os.tmpdir(), "voice-hook-")), VOICE_MCP_STAY_IN_VOICE: "0" };
  const ev = (event, extra = {}) => handle({ session_id: "s1", hook_event_name: event, ...extra }, { env });
  ev("PostToolUse", { tool_name: TOOL, tool_input: { text_to_speak: "Deploy?" }, tool_response: heard });
  leaveInInbox(env, "wait");
  assert.equal(ev("PostToolUse", { tool_name: "Read", tool_input: {}, tool_response: "x" }).exitCode, 2);
  assert.deepEqual(ev("Stop"), { exitCode: 0 });
});

test("a spoken update that doesn't wait for an answer keeps the mic open while Claude works", () => {
  const { env, run, spoke } = setup();
  const mark = path.join(env.VOICE_MCP_CACHE_DIR, "voice-mode", "listening.state");
  const update = [reply("(Speaking in the background, so you can carry on working. The microphone was not opened, because listen was false.)"), { text_to_speak: "Give me a few minutes.", listen: false }];
  spoke();
  spoke(...update, Date.now() + 1000);
  assert.equal(JSON.parse(readFileSync(mark, "utf8")).session, "s1", "still listening");
  assert.ok(JSON.parse(readFileSync(mark, "utf8")).at > Date.now(), "marked again, so the server knows this turn is still in voice mode");
  leaveInInbox(env, "skip the slow tests");
  assert.equal(run("PostToolUse", { tool_name: "Bash", tool_input: {}, tool_response: "ok" }).exitCode, 2, "and what's said still reaches Claude");

  // Not while the mic is closed (a goodbye after typing), and not when the update failed.
  const b = setup();
  b.spoke(...update);
  assert.equal(existsSyncW(path.join(b.env.VOICE_MCP_CACHE_DIR, "voice-mode", "listening.state")), false);
  const c = setup();
  c.spoke();
  c.spoke({ content: [{ type: "text", text: "voice-mcp is not set up yet: …" }], isError: true }, update[1]);
  assert.equal(existsSyncW(path.join(c.env.VOICE_MCP_CACHE_DIR, "voice-mode", "listening.state")), false);
});

test("when Claude finishes for real, the mic closes; a nudge back into voice keeps it open", () => {
  const { env, run, spoke } = setup();
  const mark = path.join(env.VOICE_MCP_CACHE_DIR, "voice-mode", "listening.state");
  spoke();
  assert.equal(run("Stop").exitCode, 2, "nudged back to speak_and_listen");
  assert.equal(existsSyncW(mark), true);
  assert.deepEqual(run("Stop"), { exitCode: 0 });
  assert.equal(existsSyncW(mark), false);

  const off = { VOICE_MCP_CACHE_DIR: mkdtempSync(path.join(os.tmpdir(), "voice-hook-")), VOICE_MCP_STAY_IN_VOICE: "0" };
  handle({ session_id: "s1", hook_event_name: "PostToolUse", tool_name: TOOL, tool_input: { text_to_speak: "Deploy?" }, tool_response: heard }, { env: off });
  handle({ session_id: "s1", hook_event_name: "Stop" }, { env: off });
  assert.equal(existsSyncW(path.join(off.VOICE_MCP_CACHE_DIR, "voice-mode", "listening.state")), false, "also with nudges off");
});

test("when the user starts typing during a voice turn, voice mode ends: no nudge back to voice", () => {
  const { env, run, spoke } = setup();
  spoke();
  spoke(reply("(The user started typing instead of answering by voice, so voice-mcp stopped speaking and listening.)"));
  assert.deepEqual(run("Stop"), { exitCode: 0 });
  assert.equal(existsSyncW(path.join(env.VOICE_MCP_CACHE_DIR, "voice-mode", "listening.state")), false, "and the mic stays closed");
});

// --- A call ----------------------------------------------------------------------------------

/** What the server writes at call start (src/call.ts). */
function startCall(env, session, run) {
  const file = path.join(env.VOICE_MCP_CACHE_DIR, "voice-mode", "call.json");
  mkdirSyncW(path.dirname(file), { recursive: true });
  writeFileSyncW(file, JSON.stringify({ pid: 123, startedAt: 1, duplex: "half" }));
  run("PostToolUse", { tool_name: CALL_TOOL, tool_input: { action: "start" }, tool_response: reply("The call is on: …") });
  return file;
}

test("call start marks the call as this session's; what the user says on it is handed over mid-turn, to this session only", () => {
  const { env, run, spoke } = setup();
  spoke(); // voice mode was on: the call replaces it
  const file = startCall(env, "s1", run);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { pid: 123, startedAt: 1, duplex: "half", session: "s1" });
  assert.deepEqual(run("Stop"), { exitCode: 0 }, "no nudge back to speak_and_listen during a call");
  leaveInInbox(env, "use the other branch");
  const other = handle({ session_id: "s2", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {}, tool_response: "ok" }, { env });
  assert.deepEqual(other, { exitCode: 0 }, "another session doesn't get it");
  const r = run("PostToolUse", { tool_name: "Bash", tool_input: {}, tool_response: "ok" });
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /the user said by voice: "use the other branch".*next natural pause \(say\)/);
  assert.deepEqual(run("PostToolUse", { tool_name: "Bash", tool_input: {}, tool_response: "ok" }), { exitCode: 0 }, "delivered once");
});

test("typing keeps the call; the session ending removes call.json (the server then hangs up)", () => {
  const { env, run } = setup();
  const file = startCall(env, "s1", run);
  run("UserPromptSubmit", { prompt: "also check the tests" });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).session, "s1");
  handle({ session_id: "s2", hook_event_name: "SessionEnd" }, { env });
  assert.ok(existsSyncW(file), "another session ending leaves the call alone");
  run("SessionEnd");
  assert.equal(existsSyncW(file), false);
});

test("a failed call start, or call end, leaves call.json alone", () => {
  const { env, run } = setup();
  run("PostToolUse", { tool_name: CALL_TOOL, tool_input: { action: "start" }, tool_response: { content: [{ type: "text", text: "voice-mcp is not set up yet: …" }], isError: true } });
  assert.equal(existsSyncW(path.join(env.VOICE_MCP_CACHE_DIR, "voice-mode", "call.json")), false);
  run("PostToolUse", { tool_name: CALL_TOOL, tool_input: { action: "end" }, tool_response: reply("(The call ended.") });
  assert.equal(existsSyncW(path.join(env.VOICE_MCP_CACHE_DIR, "voice-mode", "call.json")), false);
});
