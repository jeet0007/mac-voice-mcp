#!/usr/bin/env node
/**
 * Local hardware test. CI has no speakers or mic, so this runs on your Mac: it starts the real
 * server, talks to it over MCP exactly as Claude does, uses the real speakers and mic, and
 * measures speed and resources.
 *
 *   npm run test:local                        this checkout, packed and installed as npm would
 *   npm run test:local -- --compare 0.7.0     the same checks on a published version, side by side
 *   npm run test:local -- --turns 5           more voice turns for steadier numbers (default 3)
 *
 * The voice turns run by themselves. While the server listens, this script says a known
 * sentence through the speakers with `say`, the mic hears it, and the transcript is scored.
 * So: volume up, a quiet room, and no voice mode in another session while it runs (the
 * typing test writes the same stop file Voice Buddy does).
 *
 * Results are printed as a table and saved to local-test-results/ (gitignored).
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const COMPARE = flag("--compare");
const TURNS = Math.max(1, Number(flag("--turns", "3")));

const SENTENCE = "The build passed and all tests are green. Should I open the pull request now?";
const LONG_REPLY =
  "This is a long reply to test typing to interrupt. It keeps going for a while, so there is time to type. " +
  "If you hear this whole sentence, the interrupt did not work.";

const CACHE_ROOT =
  process.env.VOICE_MCP_CACHE_DIR?.trim() || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "mac-voice-mcp");
const STOP_FILE = path.join(CACHE_ROOT, "voice-mode", "stop");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const text = (r) => (r.content ?? []).map((c) => c.text).join("\n");

// --- Word error rate (same idea as src/wer.ts, kept here so --compare can test any version) ----

function words(s) {
  return s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
}
function wer(reference, hypothesis) {
  const r = words(reference), h = words(hypothesis);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return r.length ? d[r.length][h.length] / r.length : 0;
}

// --- Install the package the way users get it, with a cold npm cache ---------------------------

function dirSize(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else if (e.isFile()) total += statSync(p).size;
  }
  return total;
}

async function install(spec, work) {
  const dir = path.join(work, "install-" + Math.random().toString(36).slice(2, 8));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), '{"name":"local-test","private":true}');
  const t = performance.now();
  await run("npm", ["install", "--no-audit", "--no-fund", "--silent", "--cache", path.join(dir, ".npm-cache"), spec], { cwd: dir });
  const installMs = performance.now() - t;
  const ls = await run("npm", ["ls", "--all", "--parseable"], { cwd: dir }).catch((e) => e);
  const packages = (ls.stdout ?? "").trim().split("\n").slice(1).filter((p) => !p.endsWith(`${path.sep}mac-voice-mcp`)).length;
  const nm = path.join(dir, "node_modules");
  return { entry: path.join(nm, "mac-voice-mcp", "dist", "index.js"), installMs, packages, sizeMB: dirSize(nm) / 1e6 };
}

// --- Resource sampling: the server's node process and its children (recorder, whisper, …) ------

/** ps "TIME" to seconds: "0:01.23" (macOS) or "00:00:01" (Linux). */
function cpuSeconds(s) {
  return s.trim().split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
}

function sampler(pid) {
  const out = { rssIdleMB: NaN, rssPeakMB: 0, childrenPeakMB: 0, cpuSeconds: NaN };
  let busy = false;
  const sample = async () => {
    if (busy) return;
    busy = true;
    try {
      const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,rss=,time=,comm="]);
      let children = 0;
      for (const line of stdout.trim().split("\n")) {
        const [p, pp, rss, time] = line.trim().split(/\s+/);
        if (Number(p) === pid) {
          out.rssPeakMB = Math.max(out.rssPeakMB, Number(rss) / 1024);
          out.cpuSeconds = cpuSeconds(time);
        } else if (Number(pp) === pid) children += Number(rss) / 1024;
      }
      out.childrenPeakMB = Math.max(out.childrenPeakMB, children);
    } catch {
      /* the process may have just exited */
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(sample, 250);
  return {
    out,
    sample,
    idle: async () => {
      await sample();
      out.rssIdleMB = out.rssPeakMB;
    },
    stop: async () => {
      await sample();
      clearInterval(timer);
    },
  };
}

async function childNames(pid) {
  const { stdout } = await run("ps", ["-A", "-o", "ppid=,comm="]);
  return stdout
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter(([pp]) => Number(pp) === pid)
    .map(([, ...comm]) => path.basename(comm.join(" ")));
}

// --- The checks, against one server ------------------------------------------------------------

async function testTarget(label, entry, extra = {}) {
  console.log(`\n▶ ${label}`);
  const r = { label, ...extra, checks: {} };
  const check = (name, ok, detail) => {
    r.checks[name] = { ok, detail };
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  };

  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...process.env }, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (d) => (stderr += d));
  const client = new Client({ name: "local-test", version: "0" });
  let t = performance.now();
  await client.connect(transport);
  r.startupMs = performance.now() - t;
  const pid = transport.pid;
  const res = sampler(pid);

  // A voice turn that would wait for another session's mic is a broken test, not a slow one.
  const call = (params, { onPhase, signal } = {}) =>
    client.callTool(params, undefined, {
      signal,
      timeout: 120_000,
      resetTimeoutOnProgress: true,
      onprogress: (p) => {
        if (/^waiting/.test(p.message ?? "")) {
          console.error("\n  Another voice session on this Mac is using the mic. Stop voice mode there and run again.");
          process.exit(2);
        }
        onPhase?.(p.message);
      },
    });

  try {
    t = performance.now();
    const tools = (await client.listTools()).tools.map((x) => x.name).sort();
    r.toolsListMs = performance.now() - t;
    check("Tools", tools.join() === "speak_and_listen,voice_setup", tools.join(", "));
    await res.idle();

    const setup = await call({ name: "voice_setup", arguments: {} });
    check("Setup", !setup.isError, setup.isError ? text(setup).slice(0, 200) : "ok");

    // Speak only: returns at once and speaks in the background.
    t = performance.now();
    const announce = await call({ name: "speak_and_listen", arguments: { text_to_speak: "Local test. Speaking only.", listen: false } });
    r.speakOnlyReturnMs = performance.now() - t;
    check("Speak only", !announce.isError && r.speakOnlyReturnMs < 1500, `returned after ${Math.round(r.speakOnlyReturnMs)} ms`);
    await sleep(2500);

    // Voice turns: the script answers through the speakers while the server listens.
    r.turns = [];
    for (let i = 1; i <= TURNS; i++) {
      let sayDone = null;
      let speaking = null;
      t = performance.now();
      const result = await call(
        { name: "speak_and_listen", arguments: { text_to_speak: `Turn ${i}. Go ahead.`, listen_seconds: 25 } },
        {
          onPhase: (phase) => {
            if (phase === "listening" && !speaking) {
              speaking = spawn("say", [SENTENCE], { stdio: "ignore" });
              speaking.on("exit", () => (sayDone = performance.now()));
            }
          },
        },
      );
      const end = performance.now();
      const heard = result.content?.[0]?.text ?? "";
      const timing = text(result).match(/spoke ([\d.]+) s.*?listened ([\d.]+) s.*?transcribed ([\d.]+) s/s);
      const turn = {
        totalMs: end - t,
        replyAfterStopMs: sayDone ? end - sayDone : NaN,
        wer: wer(SENTENCE, heard),
        spokeS: timing ? Number(timing[1]) : NaN,
        transcribedS: timing ? Number(timing[3]) : NaN,
        heard,
      };
      r.turns.push(turn);
      check(
        `Voice turn ${i}`,
        !result.isError && turn.wer <= 0.3,
        `${Math.round(turn.wer * 100)}% word errors, reply ${(turn.replyAfterStopMs / 1000).toFixed(2)} s after the speaker stopped — "${heard.slice(0, 80)}"`,
      );
      await sleep(800);
    }

    // Typing stops a turn (what Voice Buddy does at the first keystroke).
    {
      let typedAt = null;
      const result = await call(
        { name: "speak_and_listen", arguments: { text_to_speak: LONG_REPLY } },
        {
          onPhase: (phase) => {
            if (phase === "speaking" && !typedAt)
              setTimeout(() => {
                typedAt = performance.now();
                mkdirSync(path.dirname(STOP_FILE), { recursive: true });
                writeFileSync(STOP_FILE, JSON.stringify({ at: Date.now() }));
              }, 1000);
          },
        },
      );
      r.typingStopMs = typedAt ? performance.now() - typedAt : NaN;
      check(
        "Typing stops the voice",
        /^\(The user started typing/.test(result.content?.[0]?.text ?? "") && r.typingStopMs < 1500,
        `stopped ${Math.round(r.typingStopMs)} ms after the keystroke`,
      );
      await sleep(800);
    }

    // Cancelling a call (Esc in Claude) stops the mic, and the next call still works.
    {
      const controller = new AbortController();
      let abortedAt = null;
      const pending = call(
        { name: "speak_and_listen", arguments: { text_to_speak: "Cancel test.", listen_seconds: 25 } },
        {
          signal: controller.signal,
          onPhase: (phase) => {
            if (phase === "listening" && !abortedAt)
              setTimeout(() => {
                abortedAt = performance.now();
                controller.abort();
              }, 700);
          },
        },
      );
      const rejected = await pending.then(
        () => false,
        () => true,
      );
      await sleep(1000);
      const left = (await childNames(pid)).filter((n) => /^(rec|sox|ffmpeg)$/.test(n));
      t = performance.now();
      const next = await call({ name: "voice_setup", arguments: {} });
      r.afterCancelMs = performance.now() - t;
      check(
        "Cancel",
        rejected && left.length === 0 && !next.isError,
        left.length ? `recorder still running: ${left.join(", ")}` : `mic closed; next call answered in ${Math.round(r.afterCancelMs)} ms`,
      );
    }
  } catch (err) {
    check("Run", false, `${err instanceof Error ? err.message : err}\n${stderr.slice(-2000)}`);
  } finally {
    await res.stop();
    Object.assign(r, res.out);
    await client.close().catch(() => {});
  }
  return r;
}

// --- Report ------------------------------------------------------------------------------------

function table(results) {
  const ms = (x) => (Number.isFinite(x) ? `${Math.round(x)} ms` : "–");
  const s = (x) => (Number.isFinite(x) ? `${(x / 1000).toFixed(2)} s` : "–");
  const mb = (x) => (Number.isFinite(x) ? `${x.toFixed(1)} MB` : "–");
  const rows = [
    ["Install (cold npm cache)", (r) => s(r.installMs)],
    ["Runtime packages", (r) => (r.packages ?? "–").toString()],
    ["node_modules size", (r) => mb(r.sizeMB)],
    ["Startup to ready", (r) => ms(r.startupMs)],
    ["tools/list", (r) => (Number.isFinite(r.toolsListMs) ? `${r.toolsListMs.toFixed(1)} ms` : "–")],
    ["Speak only: returns after", (r) => ms(r.speakOnlyReturnMs)],
    ["Reply after you stop (median)", (r) => s(median((r.turns ?? []).map((t) => t.replyAfterStopMs)))],
    ["Transcription (median)", (r) => (Number.isFinite(median((r.turns ?? []).map((t) => t.transcribedS))) ? `${median(r.turns.map((t) => t.transcribedS)).toFixed(2)} s` : "–")],
    ["Word errors (median)", (r) => (r.turns?.length ? `${Math.round(median(r.turns.map((t) => t.wer)) * 100)}%` : "–")],
    ["Typing stops the voice in", (r) => ms(r.typingStopMs)],
    ["Server memory, idle", (r) => mb(r.rssIdleMB)],
    ["Server memory, peak", (r) => mb(r.rssPeakMB)],
    ["Child processes, peak", (r) => mb(r.childrenPeakMB)],
    ["Server CPU time, whole run", (r) => (Number.isFinite(r.cpuSeconds) ? `${r.cpuSeconds.toFixed(2)} s` : "–")],
    ["Checks passed", (r) => `${Object.values(r.checks).filter((c) => c.ok).length}/${Object.keys(r.checks).length}`],
  ];
  const head = ["", ...results.map((r) => r.label)];
  const body = rows.map(([name, f]) => [name, ...results.map(f)]);
  const widths = head.map((_, i) => Math.max(...[head, ...body].map((row) => row[i].length)));
  const line = (row) => row.map((c, i) => c.padEnd(widths[i])).join("   ");
  return [line(head), widths.map((w) => "─".repeat(w)).join("   "), ...body.map(line)].join("\n");
}

async function main() {
  if (process.platform !== "darwin") console.warn("Not macOS: this test is meant for a Mac's real speakers and mic.");
  const work = mkdtempSync(path.join(os.tmpdir(), "voice-mcp-local-test-"));
  try {
    console.log("Packing this checkout…");
    const packed = execFileSync("npm", ["pack", "--silent", "--pack-destination", work], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").pop();
    const version = JSON.parse(execFileSync("npm", ["pkg", "get", "version"], { cwd: ROOT, encoding: "utf8" }));

    const targets = [];
    if (COMPARE) targets.push({ label: `${COMPARE} (npm)`, spec: `mac-voice-mcp@${COMPARE}` });
    targets.push({ label: `this checkout (${version})`, spec: path.join(work, packed) });

    const results = [];
    for (const target of targets) {
      console.log(`Installing ${target.spec}…`);
      const installed = await install(target.spec, work);
      const { entry, ...metrics } = installed;
      results.push(await testTarget(target.label, entry, metrics));
    }

    console.log("\n" + table(results) + "\n");
    const outDir = path.join(ROOT, "local-test-results");
    mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify({ date: new Date().toISOString(), machine: { os: `${os.type()} ${os.release()}`, arch: os.arch(), node: process.version }, results }, null, 2));
    console.log(`Saved ${path.relative(ROOT, file)}`);
    process.exitCode = results.every((r) => Object.values(r.checks).every((c) => c.ok)) ? 0 : 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
