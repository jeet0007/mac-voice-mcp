#!/usr/bin/env node
// The command-line entry point: the MCP server on stdio, and the setup, doctor, test and flight recorder commands. See docs/specs/setup-and-doctor.md.
import { createInterface } from "node:readline/promises";
import { DEFAULT_LISTEN_SECONDS, envNum, log, PKG } from "./config.js";
import { startServer } from "./server.js";
import { runDoctor } from "./doctor.js";
import { flightDir, flightEnabled, flightFlag, flightMode, flightPurge, flightStatus } from "./flight.js";
import { stopKokoro } from "./kokoro.js";
import { runSetupFlow } from "./setup.js";
import { stopWhisperServer } from "./stt.js";
import { speakAndListen } from "./voice.js";

function printHelp(): void {
  console.error(`${PKG.name} v${PKG.version} — local voice bridge MCP server

Usage:
  npx -y ${PKG.name}                  Start the MCP server on stdio (what MCP clients run)
  npx -y ${PKG.name} setup            Check what's installed; offers to install what's missing
  npx -y ${PKG.name} setup --install  Install what's missing without asking (brew + model download)
  npx -y ${PKG.name} setup --kokoro   Install the optional Kokoro voice (about 1 GB on disk)
  npx -y ${PKG.name} setup --bubble   Build the floating call bubble on this Mac (needs Xcode's Command Line Tools)
  npx -y ${PKG.name} test ["text"]    Speak, listen for one turn and print the transcript
  npx -y ${PKG.name} doctor           Self-check: setup, voice → transcript, speakers → mic (PASS/WARN/FAIL)
  npx -y ${PKG.name} doctor --no-loopback   …without playing sound through the speakers
  npx -y ${PKG.name} flag ["note"]    Save the last minute of the flight recorder to a local file (needs it on)
  npx -y ${PKG.name} flight status|purge   Show the flight recorder's folder and size, or delete it
  npx -y ${PKG.name} --version

Environment variables (all optional):
  VOICE_MCP_WHISPER_MODEL          whisper.cpp model name (default: base.en)
  VOICE_MCP_WHISPER_MODEL_PATH     use this ggml model file
  VOICE_MCP_MODEL_SEARCH_PATHS     extra folders to look in for an existing model (":"-separated)
  VOICE_MCP_LANGUAGE               spoken language: en, th, de, … or auto
  VOICE_MCP_WHISPER_PROMPT         words to expect, to hear them better (default: a developer word list; none = off)
  VOICE_MCP_VOICE / _RATE          macOS say voice and words-per-minute
  VOICE_MCP_TTS                    auto (Kokoro once installed) | say | kokoro
  VOICE_MCP_KOKORO_VOICE           Kokoro voice (default af_heart; e.g. af_bella, am_michael, bf_emma)
  VOICE_MCP_KOKORO_SPEED           Kokoro speed, 0.5–2 (default 1)
  VOICE_MCP_END_SILENCE_MS         pause length that ends your turn (default 1500)
  VOICE_MCP_START_TIMEOUT_SECONDS  wait this long for you to start talking (default 15)
  VOICE_MCP_SPEECH_MARGIN_DB       how far above room noise counts as speech (default 12)
  VOICE_MCP_WHISPER_SERVER         0 to always use whisper-cli (no warm server)
  VOICE_MCP_SERVER_IDLE_MINUTES    stop the warm server after this idle time (default 15)
  VOICE_MCP_CHIME                  0 to disable the mic sounds (open, close, nothing heard, error)
  VOICE_MCP_SPOKEN_ERRORS          0 to stop saying one short line out loud when a voice turn can't work
  VOICE_MCP_CALL_BUBBLE            0 to never show the floating call bubble
  VOICE_MCP_FLIGHT_RECORDER        off (default) | on | audio: keep a local log of what a turn decided, for "flag" (7 days, never transcripts)
  VOICE_MCP_DEBUG                  1 for verbose logs and timings (stderr)`);
}

async function runSetupCli(args: string[]): Promise<number> {
  console.error(`${PKG.name} v${PKG.version} on ${process.platform}/${process.arch}, Node ${process.version}\n`);
  const force = args.includes("--install") || args.includes("-y");
  const kokoro = args.includes("--kokoro");
  const bubble = args.includes("--bubble");
  const onProgress = (m: string) => console.error(`  … ${m}`);
  let outcome = await runSetupFlow({ install: force, kokoro, bubble, onProgress });

  if (!force && !outcome.ready && !outcome.installing && process.stdin.isTTY && /ask the user whether/.test(outcome.report)) {
    console.error(outcome.report.replace(/\nNext:.*$/s, ""));
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = (await rl.question("\nInstall the missing pieces now? [Y/n] ")).trim().toLowerCase();
    rl.close();
    if (answer !== "" && !answer.startsWith("y")) return 1;
    outcome = await runSetupFlow({ install: true, onProgress });
  }
  while (outcome.installing) outcome = await runSetupFlow({ onProgress });

  console.error(outcome.report);
  return outcome.ready ? 0 : 1;
}

async function runDoctorCli(args: string[]): Promise<number> {
  console.error(`${PKG.name} v${PKG.version} doctor — checking the voice pipeline on this machine\n`);
  const loopback = !args.includes("--no-loopback");
  if (loopback) console.error("You'll hear a short sentence from the speakers. Keep the room quiet and don't talk.\n");
  if (flightEnabled()) console.error(`Flight recorder is ${flightMode()}: events are kept on this Mac in ${flightDir()} (flight status | flight purge).\n`);
  const report = await runDoctor({ loopback, log: (line) => console.error(line) });
  console.error(`\n${report.ok ? "All checks passed." : "Some checks failed — see the details above."}`);
  if (report.reportFile) console.error(`Report saved to ${report.reportFile}`);
  if (args.includes("--json")) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  return report.ok ? 0 : 1;
}

async function runTestCli(text?: string): Promise<number> {
  const prompt = text || "Voice bridge test. Say something after the chime, and I'll print what I heard.";
  try {
    const result = await speakAndListen(prompt, {
      listenSeconds: envNum("VOICE_MCP_TEST_SECONDS", DEFAULT_LISTEN_SECONDS),
      onPhase: (p) => console.error(`  … ${p}`),
    });
    process.stdout.write(result.text + "\n");
    for (const note of result.notes) console.error(note);
    return result.ok ? 0 : 1;
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    return 1;
  } finally {
    stopWhisperServer();
    stopKokoro();
  }
}

function runFlightCli(args: string[], note: string): number {
  if (args[0] === "flag") {
    const flag = flightFlag(note);
    if (!flag) {
      console.error("Nothing to flag: the flight recorder is off and has no log. Set VOICE_MCP_FLIGHT_RECORDER=on for the server, then try again.");
      return 1;
    }
    if (flag.tooSoon) {
      console.error(flag.summary);
      return 0;
    }
    console.error(`${flag.summary}\nSaved on this Mac (nothing was sent anywhere): ${flag.file}`);
    return 0;
  }
  if (args[0] === "purge") {
    console.error(`Deleted ${flightPurge()} file(s) from ${flightStatus().dir}`);
    return 0;
  }
  const s = flightStatus();
  console.error(`Flight recorder: ${s.mode}\nFolder: ${s.dir}${s.exists ? "" : " (nothing recorded yet)"}\n${s.files} file(s), ${(s.bytes / 1024).toFixed(1)} KB, kept ${s.days} day(s)`);
  return args[0] === undefined || args[0] === "status" ? 0 : 2;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case "serve":
      return startServer();
    case "setup":
      process.exit(await runSetupCli(rest));
    case "doctor":
      process.exit(await runDoctorCli(rest));
    case "flag":
      process.exit(runFlightCli(["flag"], rest.join(" ")));
    case "flight":
      process.exit(runFlightCli(rest, ""));
    case "test":
      process.exit(await runTestCli(rest.join(" ").trim()));
    case "-v":
    case "--version":
      console.log(PKG.version);
      return;
    case "-h":
    case "--help":
    case "help":
      printHelp();
      return;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      printHelp();
      process.exit(2);
  }
}

main().catch((err) => {
  log("Fatal:", err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
