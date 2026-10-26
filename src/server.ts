/** MCP wiring: two tools (speak_and_listen, voice_setup) and two prompts (setup, voice_mode). */
import { z } from "zod";
import { CONFIG, DEFAULT_LISTEN_SECONDS, log, MAX_LISTEN_SECONDS, PKG } from "./config.js";
import { stopKokoro } from "./kokoro.js";
import { workListener } from "./worklisten.js";
import { type CallToolResult, StdioMcpServer } from "./mcp.js";
import { locateModel } from "./model.js";
import { activeChildren, SetupError } from "./proc.js";
import { runSetupFlow } from "./setup.js";
import { stopWhisperServer } from "./stt.js";
import { SERVER_INSTRUCTIONS, SETUP_PROMPT, SETUP_TOOL_DESCRIPTION, SPEAK_TOOL_DESCRIPTION, VOICE_MODE_PROMPT } from "./texts.js";
import { exclusive, finishSpeaking, speakAndListen } from "./voice.js";

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
        const message = err instanceof Error ? err.message : String(err);
        log("speak_and_listen failed:", message);
        const prefix = err instanceof SetupError ? "voice-mcp is not set up yet: " : "voice-mcp error: ";
        return { content: [{ type: "text", text: prefix + message }], isError: true };
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
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ install, kokoro }, { progress }): Promise<CallToolResult> => {
      try {
        const outcome = await exclusive(async () => {
          await finishSpeaking(); // its checks use the speaker too
          return runSetupFlow({ install: install === true, kokoro: kokoro === true, onProgress: progress });
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
    void workListener.stop();
    stopWhisperServer();
    stopKokoro();
    for (const child of activeChildren) child.kill("SIGTERM");
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

  // Cheap, install-free: link an existing model into the cache if there is one.
  void locateModel().catch(() => null);
}
