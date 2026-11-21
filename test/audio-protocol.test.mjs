// The audio worker's wire protocol (src/audio/protocol.ts): what Node accepts from fd 3 and writes to stdin.
import assert from "node:assert/strict";
import test from "node:test";
import { EVENTS, OPS, parseCommand, parseEvent, serializeCommand, serializeEvent } from "../dist/audio/protocol.js";

const EVERY_EVENT = [
  { ev: "ready", v: 1, rate: 48000, aec: true },
  { ev: "ack", seq: 7, op: "gain", status: "ok", playedMs: 1234 },
  { ev: "ack", seq: 8, op: "aec", status: "failed", code: -10868 },
  { ev: "ack", seq: -1, op: "", status: "bad-command" },
  { ev: "pos", id: 3, playedMs: 100 },
  { ev: "done", id: 3, reason: "stopped", playedMs: 412 },
  { ev: "done", id: 4, reason: "finished", playedMs: 0 },
  { ev: "error", stage: "permission", code: 0, message: "microphone access is not granted" },
  { ev: "mic-closed" },
  { ev: "route-changed", which: "output" },
  { ev: "frames-dropped", count: 12 },
];

const EVERY_COMMAND = [
  { op: "play", id: 1, rate: 24000 },
  { op: "play", id: 2, file: "/tmp/chime.wav", gain: 0.5 },
  { op: "pcm", id: 1, b64: "AAA=" },
  { op: "end", id: 1 },
  { op: "gain", id: 1, value: 0.3, rampMs: 10 },
  { op: "pause", id: 1 },
  { op: "resume", id: 1 },
  { op: "stop", id: 1 },
  { op: "aec", on: false },
  { op: "agc", on: true },
  { op: "duck-others", level: "min" },
];

test("every event the worker sends is read back as the same event", () => {
  for (const event of EVERY_EVENT) assert.deepEqual(parseEvent(serializeEvent(event)), event);
  assert.deepEqual([...new Set(EVERY_EVENT.map((e) => e.ev))], [...EVENTS], "the list above covers every event");
});

test("an event line is one JSON object and a newline", () => {
  assert.equal(serializeEvent({ ev: "pos", id: 3, playedMs: 100 }), '{"ev":"pos","id":3,"playedMs":100}\n');
});

test("a malformed or unknown fd-3 line is dropped", () => {
  for (const line of [
    "",
    "not json",
    "42",
    "null",
    "[]",
    '{"ev":"pos"',
    "{}",
    '{"ev":"levels","db":-40}',
    '{"ev":"ready","rate":48000,"aec":true}',
    '{"ev":"ready","v":"1","rate":48000,"aec":true}',
    '{"ev":"ack","seq":1,"op":"gain","status":"fine"}',
    '{"ev":"ack","seq":"1","op":"gain","status":"ok"}',
    '{"ev":"ack","seq":1,"op":"gain","status":"ok","playedMs":"soon"}',
    '{"ev":"pos","id":1}',
    '{"ev":"pos","id":1,"playedMs":-5}',
    '{"ev":"done","id":1,"reason":"exploded","playedMs":0}',
    '{"ev":"done","id":1,"reason":"finished"}',
    '{"ev":"error","stage":"lunch","code":0,"message":"x"}',
    '{"ev":"route-changed","which":"sideways"}',
    '{"ev":"route-changed"}',
    '{"ev":"frames-dropped","count":null}',
  ]) {
    assert.equal(parseEvent(line), null, line);
  }
});

test("fields the protocol doesn't know never reach the caller", () => {
  assert.deepEqual(parseEvent('{"ev":"done","id":1,"reason":"finished","playedMs":300,"text":"hello","extra":[1]}'), { ev: "done", id: 1, reason: "finished", playedMs: 300 });
  assert.deepEqual(parseEvent('{"ev":"mic-closed","why":"because"}'), { ev: "mic-closed" });
});

test("a command goes out as one line with its seq, and comes back as the same command", () => {
  assert.equal(serializeCommand({ op: "gain", id: 1, value: 0.3, rampMs: 10 }, 5), '{"op":"gain","id":1,"value":0.3,"rampMs":10,"seq":5}\n');
  EVERY_COMMAND.forEach((command, i) => assert.deepEqual(parseCommand(serializeCommand(command, i)), { ...command, seq: i }));
  assert.deepEqual([...new Set(EVERY_COMMAND.map((c) => c.op))], [...OPS], "the list above covers every command");
});

test("a malformed or unknown command is refused", () => {
  for (const line of [
    "not json",
    '{"op":"gain","id":1,"value":0.3}',
    '{"op":"rewind","id":1,"seq":1}',
    '{"op":"play","id":1,"seq":1}',
    '{"op":"play","rate":24000,"seq":1}',
    '{"op":"pcm","id":1,"seq":1}',
    '{"op":"gain","id":1,"value":"loud","seq":1}',
    '{"op":"gain","id":1,"value":-1,"seq":1}',
    '{"op":"stop","seq":1}',
    '{"op":"aec","on":"yes","seq":1}',
    '{"op":"duck-others","level":"lots","seq":1}',
  ]) {
    assert.equal(parseCommand(line), null, line);
  }
});
