#!/usr/bin/env node
/**
 * Call mode Phase 0, route C: a Stop hook that, while scripts/spikes/drive.mjs runs route c against
 * this session, holds the stop until the next utterance arrives and blocks with it, so Claude's turn
 * goes on with the utterance as the reason. Any other time it lets Claude stop at once.
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SPIKES = path.join(os.homedir(), ".cache", "mac-voice-mcp", "spikes");
const WAIT_MS = 570_000; // under the hook's 600 s timeout, so it ends on our terms
const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const event = JSON.parse(raw || "{}");
const active = readJson(path.join(SPIKES, "active.json"));
if (active?.route !== "c" || active.sessionId !== event.session_id) process.exit(0);

const waiting = path.join(SPIKES, "c-waiting.json");
writeFileSync(waiting, JSON.stringify({ sessionId: event.session_id, at: Date.now(), stopHookActive: event.stop_hook_active }));
const end = Date.now() + WAIT_MS;
let u = null;
while (Date.now() < end && readJson(path.join(SPIKES, "active.json"))?.route === "c") {
  u = readJson(path.join(SPIKES, "inbox.json"));
  if (u?.route === "c") break;
  u = null;
  await new Promise((r) => setTimeout(r, 50));
}
rmSync(waiting, { force: true });
if (!u) process.exit(0);
renameSync(path.join(SPIKES, "inbox.json"), path.join(SPIKES, "inbox.taken.json"));
writeFileSync(path.join(SPIKES, "ack.json"), JSON.stringify({ id: u.id, pickedAt: Date.now() }));
process.stdout.write(JSON.stringify({ decision: "block", reason: u.text }));
