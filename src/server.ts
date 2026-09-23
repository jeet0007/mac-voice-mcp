/** MCP wiring: two tools (speak_and_listen, voice_setup) and two prompts (setup, voice_mode). */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { z } from "zod";
import { CONFIG, DEFAULT_LISTEN_SECONDS, log, MAX_LISTEN_SECONDS, PKG } from "./config.js";
import { locateModel } from "./model.js";
import { activeChildren, SetupError } from "./proc.js";
import { runSetupFlow } from "./setup.js";
import { stopWhisperServer } from "./stt.js";
import { SERVER_INSTRUCTIONS, SETUP_PROMPT, SETUP_TOOL_DESCRIPTION, SPEAK_TOOL_DESCRIPTION, VOICE_MODE_PROMPT } from "./texts.js";
import { exclusive, speakAndListen } from "./voice.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * MCP progress notifications, when the client asked for them (it sent a progressToken).
 * They show what's happening and keep clients that reset their timeout on progress happy.
 */
function progressReporter(extra: Extra): ((message: string) => void) | undefined {
  const token = extra._meta?.progressToken;
  if (token === undefined) return undefined;
  let progress = 0;
  return (message) => {
    extra
      .sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++progress, message } })
      .catch(() => {});
  };
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "voice-mcp", title: "Voice bridge", version: PKG.version },
    { instructions: SERVER_INSTRUCTIONS },
  );

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
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ text_to_speak, listen_seconds }, extra): Promise<CallToolResult> => {
      const progress = progressReporter(extra);
      try {
        const result = await exclusive(() =>
          speakAndListen(text_to_speak, listen_seconds ?? DEFAULT_LISTEN_SECONDS, extra.signal, (phase) => progress?.(phase)),
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
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ install }, extra): Promise<CallToolResult> => {
      try {
        const outcome = await exclusive(() => runSetupFlow(install === true, progressReporter(extra)));
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
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopWhisperServer();
    for (const child of activeChildren) child.kill("SIGTERM");
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    process.exit(code);
  };
  process.stdin.on("close", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  await server.connect(transport);
  log(`${PKG.name} v${PKG.version} ready on stdio (model: ${CONFIG.modelPath ?? CONFIG.modelName}, language: ${CONFIG.language})`);
  if (process.stdin.isTTY) {
    log("This is an MCP server and expects an MCP client on stdin. Try `setup` or `test` instead, or see --help.");
  }

  // Cheap, install-free: link an existing model into the cache if there is one.
  void locateModel().catch(() => null);
}
