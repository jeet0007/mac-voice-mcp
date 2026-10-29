#!/usr/bin/env node
/**
 * Call mode Phase 0 driver (docs/specs/call-mode.md): delivers N scripted utterances into an idle
 * Claude Code session through route a, b or c, and logs delivered/N and end of speech → turn start.
 *
 *   node scripts/spikes/drive.mjs <a|b|c> [--session <pid|name|sessionId>] [--count 20] [--timeout 60]
 *
 * "End of speech" is the moment the utterance lands in the inbox the route reads. "Turn start" is
 * the first api-request row the session's transcript records after the utterance, i.e. the model
 * call begins (excludes model time). An utterance counts as delivered only once Claude replies.
 * Throwaway: see scripts/spikes/README.md.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const [route, ...rest] = process.argv.slice(2);
const opt = (f, d) => (rest.includes(f) ? rest[rest.indexOf(f) + 1] : d);
if (!["a", "b", "c"].includes(route)) {
  console.error("usage: drive.mjs <a|b|c> [--session <pid|name|sessionId>] [--count 20] [--timeout 60]");
  process.exit(2);
}
const COUNT = Number(opt("--count", 20));
const TIMEOUT_MS = Number(opt("--timeout", 60)) * 1000;

const HOME = os.homedir();
const SPIKES = path.join(HOME, ".cache", "mac-voice-mcp", "spikes");
const SESSIONS = path.join(HOME, ".claude", "sessions");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};
const writeAtomic = (f, data) => {
  writeFileSync(`${f}.tmp`, JSON.stringify(data));
  renameSync(`${f}.tmp`, f);
};

function findSession(want) {
  const all = readdirSync(SESSIONS)
    .filter((f) => /^\d+\.json$/.test(f))
    .map((f) => ({ file: path.join(SESSIONS, f), ...readJson(path.join(SESSIONS, f)) }))
    .filter((s) => s.sessionId && s.kind === "interactive");
  const hit = want
    ? all.find((s) => String(s.pid) === want || s.name === want || s.sessionId === want)
    : all.filter((s) => s.cwd === process.cwd()).sort((x, y) => y.startedAt - x.startedAt)[0];
  if (!hit) throw new Error(want ? `no interactive session matches ${want}` : `no interactive session in ${process.cwd()}; pass --session`);
  return hit;
}

function transcriptOf(sessionId) {
  const projects = path.join(HOME, ".claude", "projects");
  for (const dir of readdirSync(projects)) {
    const f = path.join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

function rows(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return { line, ...JSON.parse(line) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Where `token` first shows up (not in Claude's own reply), the model call after it, and Claude's reply. */
function locate(file, token) {
  const all = rows(file);
  const i = all.findIndex((r) => r.type !== "assistant" && r.line.includes(token));
  if (i < 0) return null;
  const after = all.slice(i);
  const ts = (r) => (r?.timestamp ? Date.parse(r.timestamp) : undefined);
  return {
    rowType: all[i].type,
    rowAt: ts(all[i]),
    requestAt: ts(after.find((r) => r.type === "api-request" && r.timestamp)),
    replyAt: ts(after.find((r) => r.type === "assistant" && r.timestamp)),
  };
}

/** Is the session ready for the next utterance? a/b: idle. c: the Stop hook is waiting. */
function ready(session) {
  if (route === "c") return readJson(path.join(SPIKES, "c-waiting.json"))?.sessionId === session.sessionId;
  return readJson(session.file)?.status === "idle";
}

async function waitFor(check, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = check();
    if (v) return v;
    await sleep(50);
  }
  return null;
}

const session = findSession(opt("--session"));
const transcript = transcriptOf(session.sessionId);
const runId = Date.now().toString(36);
mkdirSync(SPIKES, { recursive: true });
const log = path.join(SPIKES, `results-${route}-${runId}.jsonl`);
rmSync(path.join(SPIKES, "inbox.json"), { force: true });
rmSync(path.join(SPIKES, "ack.json"), { force: true });
writeAtomic(path.join(SPIKES, "active.json"), { route, sessionId: session.sessionId, runId });
console.log(`route ${route} → session ${session.name ?? ""} pid ${session.pid} (${session.sessionId})`);
console.log(`transcript ${transcript ?? "(not found yet)"}\nlog ${log}`);
if (route === "c") console.log("waiting for the Stop hook: send the session any prompt (\"hi\") so its turn ends…");

const results = [];
try {
  for (let i = 1; i <= COUNT; i++) {
    const isReady = await waitFor(() => ready(session), route === "c" && i === 1 ? 300_000 : TIMEOUT_MS);
    if (!isReady) {
      const r = { i, delivered: false, why: "session never became ready (busy, or the Stop hook stopped waiting)" };
      results.push(r);
      appendFileSync(log, JSON.stringify(r) + "\n");
      console.log(`${String(i).padStart(2)}  NOT READY, stopping`);
      break;
    }
    if (route !== "c") await sleep(300); // let the idle status settle so a late row isn't mistaken for this turn
    const token = `spike-${route}-${runId}-${i}`;
    const text = `[${token}] Call-mode spike utterance ${i} of ${COUNT}. Reply with exactly "ok ${i}" and nothing else; use no tools.`;
    const endAt = Date.now();
    writeAtomic(path.join(SPIKES, "inbox.json"), { id: token, route, text, endAt });

    const where = await waitFor(() => {
      const w = locate(transcript ?? transcriptOf(session.sessionId), token);
      return w?.replyAt ? w : null;
    }, TIMEOUT_MS);
    const ack = readJson(path.join(SPIKES, "ack.json"));
    const r = {
      i,
      token,
      endAt,
      delivered: Boolean(where),
      rowType: where?.rowType,
      startS: where ? ((where.requestAt ?? where.rowAt) - endAt) / 1000 : null,
      rowS: where ? (where.rowAt - endAt) / 1000 : null,
      replyS: where ? (where.replyAt - endAt) / 1000 : null,
      ack: ack?.id === token ? ack : undefined,
    };
    results.push(r);
    appendFileSync(log, JSON.stringify(r) + "\n");
    console.log(
      `${String(i).padStart(2)}  ${r.delivered ? "delivered" : "MISSED   "}  start ${r.startS?.toFixed(2) ?? "-"} s  reply ${r.replyS?.toFixed(2) ?? "-"} s  ${r.rowType ?? ""}${r.ack && !r.delivered ? "  ack " + JSON.stringify(r.ack) : ""}`,
    );
    if (route === "c") await waitFor(() => !ready(session) || null, 5_000); // the hook consumed it
  }
} finally {
  rmSync(path.join(SPIKES, "active.json"), { force: true });
  rmSync(path.join(SPIKES, "inbox.json"), { force: true });
}

const starts = results.filter((r) => r.delivered && r.startS !== null).map((r) => r.startS).sort((x, y) => x - y);
const q = (p) => (starts.length ? starts[Math.min(starts.length - 1, Math.floor(p * starts.length))].toFixed(2) : "-");
const summary = `route ${route}: delivered ${starts.length}/${COUNT}; end of speech → turn start median ${q(0.5)} s, p90 ${q(0.9)} s, max ${starts.length ? starts.at(-1).toFixed(2) : "-"} s`;
appendFileSync(log, JSON.stringify({ summary }) + "\n");
console.log(`\n${summary}\nlog ${log}`);
