// Talking to Claude while it works: which speech counts, and the inbox the plugin hook reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.VOICE_MCP_CACHE_DIR = mkdtempSync(path.join(os.tmpdir(), "voice-work-"));
const { parseInterjection, addToInbox, takeInbox, interjectionNote, inboxDir, INBOX_MAX_CHARS } = await import("../dist/worklisten.js");
const { takeInterjections, interjectionReason } = await import("../hooks/voice-mode-lib.mjs");

test("only speech that starts with Claude's name is for Claude", () => {
  assert.equal(parseInterjection("Claude, use the other branch."), "use the other branch.");
  assert.equal(parseInterjection("Hey Claude, stop for a second"), "stop for a second");
  assert.equal(parseInterjection("Okay, Claude. Skip the tests."), "Skip the tests.");
  assert.equal(parseInterjection("Clyde, wait"), "wait"); // a common mishearing
  assert.equal(parseInterjection("Cloud, run it again."), "run it again.");
  assert.equal(parseInterjection("Claude?"), "", "just the name: they want to talk");
  // Not addressed to Claude.
  assert.equal(parseInterjection("I told Claude about it yesterday."), null);
  assert.equal(parseInterjection("Cloud deployment failed again."), null);
  assert.equal(parseInterjection("Can you pass the salt?"), null);
  assert.equal(parseInterjection(""), null);
});

test("the inbox hands over what was said, oldest first, once; stale entries are dropped", () => {
  const now = Date.now();
  addToInbox("use the other branch", now - 2000);
  addToInbox("and skip the slow tests", now - 1000);
  addToInbox("something from long ago", now - 60 * 60_000);
  assert.deepEqual(takeInbox(now).map((e) => e.text), ["use the other branch", "and skip the slow tests"]);
  assert.deepEqual(takeInbox(now), [], "taken once");
  assert.match(interjectionNote([{ text: "use main", at: now }, { text: "", at: now }]), /the user said by voice: "use main", then \(only your name/);
  assert.equal(interjectionNote([]), null);
});

test("the hook only hands interjections to the session that is listening", () => {
  const dir = path.join(process.env.VOICE_MCP_CACHE_DIR, "voice-mode");
  addToInbox("use the other branch");
  assert.deepEqual(takeInterjections(dir, "s1"), [], "no session is marked as listening");
  assert.match(interjectionReason(["use main"]), /While you were working, the user said by voice: "use main"/);
});

test("the inbox is private to this account, and a runaway transcript is cut short", () => {
  takeInbox(); // start empty
  mkdirSync(inboxDir(), { recursive: true });
  chmodSync(inboxDir(), 0o755); // as an older version left it
  addToInbox("x".repeat(5000));
  assert.equal(statSync(inboxDir()).mode & 0o777, 0o700);
  const [name] = readdirSync(inboxDir());
  assert.equal(statSync(path.join(inboxDir(), name)).mode & 0o777, 0o600);
  const [entry] = takeInbox();
  assert.equal(entry.text, `${"x".repeat(INBOX_MAX_CHARS)}…`);
});
