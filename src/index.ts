#!/usr/bin/env node
/**
 * mac-voice-mcp — a local voice bridge for MCP clients.
 *
 * Tools
 *   speak_and_listen(text_to_speak, listen_seconds?)
 *     1. speaks the text with native TTS (`say` on macOS)
 *     2. listens like a conversation turn: waits for the user to start talking and
 *        stops ~1.2 s after they finish (adaptive voice-activity detection)
 *     3. transcribes on-device with whisper.cpp (a warm whisper-server keeps the
 *        model loaded between turns; whisper-cli is the fallback)
 *     4. returns the transcript to the model
 *   voice_setup(install?)
 *     checks what's already installed and — only with the user's OK — installs
 *     what's missing (Homebrew packages, the speech model). Reuses everything.
 *
 * Everything runs locally. No audio leaves the machine.
 * stdout is reserved for the MCP protocol; all logging goes to stderr.
 *
 * Module map
 *   config.ts       settings (env vars), logging, PATH fix-up for GUI apps
 *   proc.ts         which / run helpers, error types
 *   speech-text.ts  screen text → ear text; transcript clean-up        (pure)
 *   endpointer.ts   turn-taking voice-activity detection               (pure)
 *   audio.ts        TTS, chimes, streaming microphone capture
 *   model.ts        find / symlink / download the whisper model
 *   stt.ts          warm whisper-server + whisper-cli fallback
 *   setup.ts        requirement checks and consent-based installs
 *   voice.ts        the speak → listen → transcribe round trip
 *   texts.ts        everything the model reads (rules, instructions, prompts)
 *   server.ts       MCP tools and prompts
 */
import { createInterface } from "node:readline/promises";
import { DEFAULT_LISTEN_SECONDS, envNum, log, PKG } from "./config.js";
import { startServer } from "./server.js";
import { runSetupFlow } from "./setup.js";
import { stopWhisperServer } from "./stt.js";
import { speakAndListen } from "./voice.js";

function printHelp(): void {
  console.error(`${PKG.name} v${PKG.version} — local voice bridge MCP server

Usage:
  npx -y ${PKG.name}                  Start the MCP server on stdio (what MCP clients run)
  npx -y ${PKG.name} setup            Check what's installed; offers to install what's missing
  npx -y ${PKG.name} setup --install  Install what's missing without asking (brew + model download)
  npx -y ${PKG.name} test ["text"]    Speak, listen for one turn and print the transcript
  npx -y ${PKG.name} --version

Environment variables (all optional):
  VOICE_MCP_WHISPER_MODEL          whisper.cpp model name (default: base.en)
  VOICE_MCP_WHISPER_MODEL_PATH     use this ggml model file
  VOICE_MCP_MODEL_SEARCH_PATHS     extra folders to look in for an existing model (":"-separated)
  VOICE_MCP_LANGUAGE               spoken language: en, th, de, … or auto
  VOICE_MCP_WHISPER_PROMPT         words to bias recognition toward (names, jargon)
  VOICE_MCP_VOICE / _RATE          macOS say voice and words-per-minute
  VOICE_MCP_END_SILENCE_MS         pause length that ends your turn (default 1200)
  VOICE_MCP_START_TIMEOUT_SECONDS  wait this long for you to start talking (default 8)
  VOICE_MCP_SPEECH_MARGIN_DB       how far above room noise counts as speech (default 12)
  VOICE_MCP_WHISPER_SERVER         0 to always use whisper-cli (no warm server)
  VOICE_MCP_SERVER_IDLE_MINUTES    stop the warm server after this idle time (default 15)
  VOICE_MCP_CHIME                  0 to disable the mic open/close sounds
  VOICE_MCP_DEBUG                  1 for verbose logs and timings (stderr)`);
}

async function runSetupCli(args: string[]): Promise<number> {
  console.error(`${PKG.name} v${PKG.version} on ${process.platform}/${process.arch}, Node ${process.version}\n`);
  const force = args.includes("--install") || args.includes("-y");
  let outcome = await runSetupFlow(force, (m) => console.error(`  … ${m}`));

  // Interactive terminal: offer to install right away.
  if (!force && !outcome.ready && !outcome.installing && process.stdin.isTTY && /ask the user whether/.test(outcome.report)) {
    console.error(outcome.report.replace(/\nNext:.*$/s, ""));
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = (await rl.question("\nInstall the missing pieces now? [Y/n] ")).trim().toLowerCase();
    rl.close();
    if (answer !== "" && !answer.startsWith("y")) return 1;
    outcome = await runSetupFlow(true, (m) => console.error(`  … ${m}`));
  }
  // In a terminal we can simply wait for background installs to finish.
  while (outcome.installing) outcome = await runSetupFlow(false, (m) => console.error(`  … ${m}`));

  console.error(outcome.report);
  return outcome.ready ? 0 : 1;
}

async function runTestCli(text?: string): Promise<number> {
  const prompt = text || "Voice bridge test. Say something after the chime, and I'll print what I heard.";
  try {
    const result = await speakAndListen(prompt, envNum("VOICE_MCP_TEST_SECONDS", DEFAULT_LISTEN_SECONDS), undefined, (p) =>
      console.error(`  … ${p}`),
    );
    process.stdout.write(result.text + "\n");
    for (const note of result.notes) console.error(note);
    return result.ok ? 0 : 1;
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    return 1;
  } finally {
    stopWhisperServer();
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case "serve":
      return startServer();
    case "setup":
    case "doctor":
      process.exit(await runSetupCli(rest));
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
