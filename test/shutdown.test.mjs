// Shutdown: children that ignore SIGTERM are SIGKILLed before the process exits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
const { activeChildren, terminateChildren } = await import("../dist/proc.js");

test("terminateChildren SIGKILLs a child that ignores SIGTERM, and lets a well-behaved one stop on SIGTERM", async () => {
  const stubborn = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});console.log('up');setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "ignore"] });
  const polite = spawn(process.execPath, ["-e", "console.log('up');setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "ignore"] });
  const exits = [stubborn, polite].map((c) => new Promise((r) => c.on("close", (code, signal) => r(signal))));
  for (const c of [stubborn, polite]) {
    activeChildren.add(c);
    c.on("close", () => activeChildren.delete(c));
  }
  await Promise.all([stubborn, polite].map((c) => new Promise((r) => c.stdout.once("data", r)))); // handlers are installed
  const t0 = Date.now();
  await terminateChildren(150);
  const [s, p] = await Promise.all(exits);
  assert.equal(p, "SIGTERM");
  assert.equal(s, "SIGKILL", "the stubborn child was killed, not left running");
  assert.ok(Date.now() - t0 < 2000);
});
