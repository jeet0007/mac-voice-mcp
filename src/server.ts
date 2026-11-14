/** MCP wiring: the tools (speak_and_listen, voice_setup, call, say, listen) and prompts (setup, voice_mode, call). */
import { z } from "zod";
import { call } from "./call.js";
import { CONFIG, DEFAULT_LISTEN_SECONDS, log, MAX_LISTEN_SECONDS, MAX_SPEAK_CHARS, PKG } from "./config.js";
import { flightEnabled, flightFlag, flightMode, startFlight } from "./flight.js";
import { stopKokoro } from "./kokoro.js";
import { interjectionNote, takeInbox, workListener } from "./worklisten.js";
import { type CallToolResult, StdioMcpServer } from "./mcp.js";
import { locateModel } from "./model.js";
import { CancelledError, SetupError, terminateChildren } from "./proc.js";
import { runSetupFlow } from "./setup.js";
import { prepareSpeech } from "./speech-text.js";
import { stopWhisperServer } from "./stt.js";
import {
  CALL_ALREADY_ON,
  CALL_ENDED_BY_CLAUDE,
  CALL_PROMPT,
  CALL_RULES,
  CALL_TOOL_DESCRIPTION,
  callEnded,
  LISTEN_TOOL_DESCRIPTION,
  NO_CALL,
  ON_CALL_USE_SAY,
  SAID,
  SAY_TOOL_DESCRIPTION,
  SERVER_INSTRUCTIONS,
  SETUP_PROMPT,
  SETUP_TOOL_DESCRIPTION,
  SPEAK_TOOL_DESCRIPTION,
  STILL_ON_CALL,
  VOICE_MODE_PROMPT,
} from "./texts.js";
import { READY_LINE, sayLineIfMicFree } from "./cues.js";
import { exclusive, finishSpeaking, preflight, speakAndListen, trackSpeaking } from "./voice.js";

/** The longest `listen` may wait: the Cowork bridge drops tool calls after 60 s. */
const MAX_LISTEN_WAIT_SECONDS = 40;

const failed = (what: string, err: unknown): CallToolResult => {
  const message = err instanceof Error ? err.message : String(err);
  log(`${what} failed:`, message);
  const prefix = err instanceof SetupError ? "voice-mcp is not set up yet: " : "voice-mcp error: ";
  // A spoken error already told the user (cues.ts); this note keeps Claude from repeating it aloud.
  const note = (err as { voiceNote?: unknown } | null)?.voiceNote;
  const notes = typeof note === "string" ? [{ type: "text" as const, text: `\n\n${note}` }] : [];
  return { content: [{ type: "text", text: prefix + message }, ...notes], isError: true };
};
const reply = (text: string, notes: string[] = [], isError = false): CallToolResult => ({
  content: [{ type: "text", text }, ...notes.map((note) => ({ type: "text" as const, text: `\n\n${note}` }))],
  isError,
});

export function createServer(): StdioMcpServer {
  const server = new StdioMcpServer({ name: "voice-mcp", title: "Voice bridge", version: PKG.version }, SERVER_INSTRUCTIONS);

  server.registerTool(
    "speak_and_listen",
    {
      title: "Speak and listen",
      description: SPEAK_TOOL_DESCRIPTION,
      inputSchema: {
        text_to_speak: z.string().min(1).describe("The summary or message to read aloud to the user. Plain, conversational text."),
        listen_seconds: z
          .number()
          .positive()
          .optional()
          .describe(
            `Upper limit on how long to listen, in seconds (default ${DEFAULT_LISTEN_SECONDS}, max ${MAX_LISTEN_SECONDS}). ` +
              "Listening already stops when the user finishes talking, so you rarely need this.",
          ),
        listen: z
          .boolean()
          .optional()
          .describe(
            "Default true. false: only speak, without opening the microphone — for a one-way announcement, " +
              "or to say goodbye when the user ends voice mode. It returns right away and speaks while you carry on.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ text_to_speak, listen_seconds, listen }, { signal, progress }): Promise<CallToolResult> => {
      const phaseMessage = (phase: string) =>
        phase === "waiting" ? "waiting for another voice session on this Mac to finish" : phase;
      if (call.on) return reply(ON_CALL_USE_SAY);
      try {
        const result = await exclusive(() =>
          speakAndListen(text_to_speak, {
            listenSeconds: listen_seconds ?? DEFAULT_LISTEN_SECONDS,
            listen,
            signal,
            onPhase: (phase) => progress?.(phaseMessage(phase)),
          }),
        );
        return {
          content: [{ type: "text", text: result.text }, ...result.notes.map((note) => ({ type: "text" as const, text: `\n\n${note}` }))],
          isError: !result.ok,
        };
      } catch (err) {
        return failed("speak_and_listen", err);
      }
    },
  );

  const startingCalls = new Set<AbortController>();
  server.registerTool(
    "call",
    {
      title: "Call",
      description: CALL_TOOL_DESCRIPTION,
      inputSchema: { action: z.enum(["start", "end"]).describe("start: take the mic (nothing is spoken); greet the user yourself, once, with say, then listen. end: hang up.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ action }, { signal }): Promise<CallToolResult> => {
      if (action === "end") {
        // An end while a start still waits for the mic cancels that start.
        for (const pending of startingCalls) pending.abort();
        await call.end("Claude ended the call");
        return reply(CALL_ENDED_BY_CLAUDE);
      }
      const ended = new AbortController();
      startingCalls.add(ended);
      try {
        return await exclusive(async () => {
          await finishSpeaking();
          await preflight();
          await workListener.stop();
          if (ended.signal.aborted) throw new CancelledError();
          if ((await call.start(AbortSignal.any([signal, ended.signal]))) === "already") return reply(CALL_ALREADY_ON);
          // Nothing is spoken here: Claude greets once, with say, so the user doesn't hear two greetings.
          return reply(CALL_RULES);
        });
      } catch (err) {
        if (err instanceof CancelledError && ended.signal.aborted && !signal.aborted) return reply(CALL_ENDED_BY_CLAUDE);
        if (err instanceof CancelledError) throw err;
        return failed("call", err);
      } finally {
        startingCalls.delete(ended);
      }
    },
  );

  server.registerTool(
    "say",
    {
      title: "Say (on a call)",
      description: SAY_TOOL_DESCRIPTION,
      inputSchema: { text: z.string().min(1).describe("What to say. Plain, conversational text.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ text }): Promise<CallToolResult> => {
      if (!call.on) return reply(call.endedBecause ? callEnded(call.endedBecause) : NO_CALL, [], true);
      const speech = prepareSpeech(text, { maxWords: CONFIG.maxSpeakWords, maxChars: MAX_SPEAK_CHARS });
      try {
        const notes = await call.say(speech.text);
        const said = interjectionNote(takeInbox());
        return reply(SAID, [...speech.notes, ...notes, ...(said ? [said] : [])]);
      } catch (err) {
        return failed("say", err);
      }
    },
  );

  server.registerTool(
    "listen",
    {
      title: "Listen (on a call)",
      description: LISTEN_TOOL_DESCRIPTION,
      inputSchema: {
        wait_seconds: z.number().positive().optional().describe(`How long to wait for the user to speak (default and maximum ${MAX_LISTEN_WAIT_SECONDS}).`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ wait_seconds }, { signal }): Promise<CallToolResult> => {
      if (!call.on) return reply(call.endedBecause ? callEnded(call.endedBecause) : NO_CALL, [], true);
      const seconds = Math.min(MAX_LISTEN_WAIT_SECONDS, Math.max(1, wait_seconds ?? MAX_LISTEN_WAIT_SECONDS));
      const said = await call.listen(seconds * 1000, signal);
      if (signal.aborted) throw new CancelledError();
      if (said.length) return reply(said.map((e) => e.text).join("\n"));
      return reply(call.on ? STILL_ON_CALL : callEnded(call.endedBecause));
    },
  );

  server.registerTool(
    "flag",
    {
      title: "Flag a moment",
      description:
        "Call only when the user explicitly asks to flag or report a bad voice turn; never on your own. " +
        "Saves the last minute of what voice-mcp did (levels, why turns ended, whether speech finished: no transcripts) to a local file. " +
        "Only works when the user turned the flight recorder on. Returns the file's path.",
      inputSchema: { note: z.string().max(500).optional().describe("Optional: what went wrong, in the user's words.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ note }): Promise<CallToolResult> => {
      if (!flightEnabled()) {
        return reply("The flight recorder is off, so there is nothing to flag. The user can turn it on with VOICE_MCP_FLIGHT_RECORDER=on (or audio) and restart.", [], true);
      }
      try {
        const flag = flightFlag(note, { withAudio: flightMode() === "audio" });
        if (!flag) return reply("Nothing to flag yet.", [], true);
        if (flag.tooSoon) return reply("Already flagged just now.");
        return reply(`Flagged. Saved on this Mac: ${flag.file}${flag.wav ? ` (audio: ${flag.wav})` : ""}\n${flag.summary}`);
      } catch (err) {
        return failed("flag", err);
      }
    },
  );

  server.registerTool(
    "voice_setup",
    {
      title: "Voice setup",
      description: SETUP_TOOL_DESCRIPTION,
      inputSchema: {
        install: z
          .boolean()
          .optional()
          .describe("false (default): only check. true: brew install missing packages and download the model. Ask the user first."),
        kokoro: z
          .boolean()
          .optional()
          .describe(
            "true: install the optional Kokoro voice — a natural-sounding neural voice that runs on this Mac " +
              "(kokoro-js via npm and a one-time model download, about 1 GB on disk). Ask the user first.",
          ),
        bubble: z
          .boolean()
          .optional()
          .describe("true: build the floating call bubble on this Mac with swiftc (about 10 s; macOS). Ask the user first."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ install, kokoro, bubble }, { progress }): Promise<CallToolResult> => {
      try {
        const outcome = await exclusive(async () => {
          await finishSpeaking(); // its checks use the speaker too
          const done = await runSetupFlow({ install: install === true, kokoro: kokoro === true, bubble: bubble === true, onProgress: progress });
          // The first READY after an install: one short line out loud, once per server process.
          if (done.announceReady) trackSpeaking(sayLineIfMicFree(READY_LINE));
          return done;
        });
        return { content: [{ type: "text", text: outcome.report }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log("voice_setup failed:", message);
        return { content: [{ type: "text", text: `voice_setup error: ${message}` }], isError: true };
      }
    },
  );

  // Claude Code: /mcp__voice-mcp__setup
  server.registerPrompt(
    "setup",
    { title: "Set up voice", description: "Check what voice-mcp needs, install what's missing (with your OK), then test it." },
    () => ({ messages: [{ role: "user", content: { type: "text", text: SETUP_PROMPT } }] }),
  );

  // Claude Desktop and Cursor: the prompt picker (Claude Code has /mac-voice-mcp:call).
  server.registerPrompt(
    "call",
    { title: "Call", description: "A call: the microphone stays open and you talk whenever you like, until you hang up." },
    () => ({ messages: [{ role: "user", content: { type: "text", text: CALL_PROMPT } }] }),
  );

  // Claude Code: /mcp__voice-mcp__voice_mode [task]; Claude Desktop and Cursor: the prompt picker.
  server.registerPrompt(
    "voice_mode",
    {
      title: "Voice mode",
      description: "Hands-free session: Claude checks in out loud via speak_and_listen, using speakable phrasing.",
      argsSchema: {
        task: z.string().optional().describe("Optional: what to work on. Claude will read its plan back to you first."),
      },
    },
    ({ task }) => ({
      messages: [{ role: "user", content: { type: "text", text: VOICE_MODE_PROMPT(task?.trim() || undefined) } }],
    }),
  );

  return server;
}

export async function startServer(): Promise<void> {
  const server = createServer();

  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    void call.end("voice-mcp shut down");
    void workListener.stop();
    stopWhisperServer();
    stopKokoro();
    await terminateChildren(); // SIGTERM, then SIGKILL for any that haven't exited
    server.close();
    process.exit(code);
  };
  process.stdin.on("close", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  server.connect();
  log(`${PKG.name} v${PKG.version} ready on stdio (model: ${CONFIG.modelPath ?? CONFIG.modelName}, language: ${CONFIG.language})`);
  if (process.stdin.isTTY) {
    log("This is an MCP server and expects an MCP client on stdin. Try `setup` or `test` instead, or see --help.");
  }

  startFlight(); // does nothing unless VOICE_MCP_FLIGHT_RECORDER is on

  // Cheap, install-free: link an existing model into the cache if there is one.
  void locateModel().catch(() => null);
}
