// The mic lock shared by every voice-mcp on the Mac (src/lock.ts).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONFIG } from "../dist/config.js";
import { acquireMicLock, lockFile, MicBusyError } from "../dist/lock.js";
import { CancelledError } from "../dist/proc.js";

/** Point the lock at a fresh folder for each test. */
function freshDir() {
  CONFIG.cacheDir = mkdtempSync(path.join(os.tmpdir(), "voice-lock-"));
  return lockFile();
}
const owner = (file) => JSON.parse(readFileSync(file, "utf8"));
const DEAD_PID = 2 ** 22 + 12345; // above the pid limit on macOS and Linux

test("take, give back, take again — and no exit listeners pile up", async () => {
  const file = freshDir();
  const listeners = process.listenerCount("exit");
  for (let i = 0; i < 50; i++) {
    const release = await acquireMicLock({ waitMs: 1000 });
    assert.equal(owner(file).pid, process.pid);
    release();
    release(); // idempotent
    assert.ok(!existsSync(file));
  }
  assert.equal(process.listenerCount("exit"), listeners);
});

test("a live owner makes others wait, then give up with MicBusyError", async () => {
  const file = freshDir();
  writeFileSync(file, JSON.stringify({ pid: process.ppid, since: Date.now() }));
  let waited = 0;
  await assert.rejects(acquireMicLock({ waitMs: 300, onWait: () => waited++ }), MicBusyError);
  assert.equal(waited, 1);
  assert.equal(owner(file).pid, process.ppid, "the owner's lock is untouched");
});

test("stale locks are taken over: dead owner, implausibly old, or unreadable for a while", async () => {
  for (const make of [
    (f) => writeFileSync(f, JSON.stringify({ pid: DEAD_PID, since: Date.now() })),
    (f) => writeFileSync(f, JSON.stringify({ pid: process.ppid, since: Date.now() - 11 * 60_000 })),
    (f) => {
      writeFileSync(f, "");
      const old = new Date(Date.now() - 60_000);
      utimesSync(f, old, old);
    },
  ]) {
    const file = freshDir();
    make(file);
    const release = await acquireMicLock({ waitMs: 1000 });
    assert.equal(owner(file).pid, process.pid);
    release();
  }
});

test("an unreadable lock that was just created is not stolen (it's being written)", async () => {
  const file = freshDir();
  writeFileSync(file, "");
  await assert.rejects(acquireMicLock({ waitMs: 300 }), MicBusyError);
});

test("several sessions taking over the same stale lock: exactly one wins", async () => {
  const file = freshDir();
  writeFileSync(file, JSON.stringify({ pid: DEAD_PID, since: Date.now() }));
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => acquireMicLock({ waitMs: 400 })));
  const winners = results.filter((r) => r.status === "fulfilled");
  assert.equal(winners.length, 1);
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason instanceof MicBusyError));
  assert.equal(owner(file).pid, process.pid);
  winners[0].value();
  assert.ok(!existsSync(file));
});

test("releasing never removes a lock someone else holds now", async () => {
  const file = freshDir();
  const release = await acquireMicLock({ waitMs: 1000 });
  writeFileSync(file, JSON.stringify({ pid: process.ppid, since: Date.now() })); // taken over meanwhile
  release();
  assert.equal(owner(file).pid, process.ppid);
});

test("cancelling while waiting stops at once and leaves the owner's lock alone", async () => {
  const file = freshDir();
  writeFileSync(file, JSON.stringify({ pid: process.ppid, since: Date.now() }));
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(acquireMicLock({ waitMs: 10_000, signal: ac.signal }), CancelledError);
  assert.equal(owner(file).pid, process.ppid);
});

test("an unusable cache folder doesn't break voice turns: they go ahead without the lock", async () => {
  const notADir = path.join(mkdtempSync(path.join(os.tmpdir(), "voice-lock-")), "file");
  writeFileSync(notADir, "x");
  CONFIG.cacheDir = path.join(notADir, "cache"); // parent is a file → ENOTDIR
  const release = await acquireMicLock({ waitMs: 300 });
  release();
});
