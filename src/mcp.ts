// A small stdio MCP server, newline-delimited JSON-RPC 2.0, in place of the MCP SDK. See docs/specs/voice-turn.md.
import { z } from "zod";

/** Newest first. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];

export interface TextContent {
  type: "text";
  text: string;
}
export interface CallToolResult {
  content: TextContent[];
  isError?: boolean;
}
export interface GetPromptResult {
  messages: { role: "user" | "assistant"; content: TextContent }[];
}

export interface ToolContext {
  signal: AbortSignal;
  /** Only there when the client sent a progressToken. */
  progress?: (message: string) => void;
}

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

type RequestId = string | number;

interface Tool {
  listing: Record<string, unknown>;
  schema: z.ZodObject;
  run: (args: never, ctx: ToolContext) => Promise<CallToolResult>;
}

interface Prompt {
  listing: Record<string, unknown>;
  schema: z.ZodObject;
  get: (args: never) => GetPromptResult;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const INVALID_PARAMS = -32602;
const METHOD_NOT_FOUND = -32601;

function describeIssues(error: z.ZodError): string {
  return error.issues.map((i) => (i.path.length ? `${i.message} at ${i.path.join(".")}` : i.message)).join("; ");
}

export class StdioMcpServer {
  private readonly tools = new Map<string, Tool>();
  private readonly prompts = new Map<string, Prompt>();
  private readonly inFlight = new Map<RequestId, AbortController>();
  private output: NodeJS.WritableStream | null = null;

  constructor(
    private readonly info: { name: string; title?: string; version: string },
    private readonly instructions?: string,
  ) {}

  registerTool<S extends z.ZodRawShape>(
    name: string,
    def: { title?: string; description: string; inputSchema: S; annotations?: ToolAnnotations },
    run: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<CallToolResult>,
  ): void {
    const schema = z.object(def.inputSchema);
    this.tools.set(name, {
      listing: {
        name,
        title: def.title,
        description: def.description,
        inputSchema: z.toJSONSchema(schema, { target: "draft-7", io: "input" }),
        annotations: def.annotations,
      },
      schema,
      run: run as Tool["run"],
    });
  }

  registerPrompt<S extends Record<string, z.ZodString | z.ZodOptional<z.ZodString>>>(
    name: string,
    def: { title?: string; description: string; argsSchema?: S },
    get: (args: z.infer<z.ZodObject<S>>) => GetPromptResult,
  ): void {
    const shape = def.argsSchema ?? ({} as S);
    const args = Object.entries(shape).map(([argName, s]) => ({
      name: argName,
      description: s.description,
      required: !s.safeParse(undefined).success,
    }));
    this.prompts.set(name, {
      listing: { name, title: def.title, description: def.description, ...(args.length ? { arguments: args } : {}) },
      schema: z.object(shape),
      get: get as Prompt["get"],
    });
  }

  connect(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): void {
    this.output = output;
    output.on("error", () => {}); // stdin's close handles shutdown
    let buffer = "";
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) this.receive(line);
      }
    });
  }

  close(): void {
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
  }

  private send(message: Record<string, unknown>): void {
    this.output?.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }

  private receive(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.send({ id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    for (const m of Array.isArray(message) ? message : [message]) this.dispatch(m);
  }

  private dispatch(message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const { id, method, params } = message as { id?: unknown; method?: unknown; params?: unknown };
    if (typeof method !== "string") return; // a response; this server never sends requests
    const p = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;

    if (typeof id !== "string" && typeof id !== "number") {
      if (method === "notifications/cancelled") this.inFlight.get(p.requestId as RequestId)?.abort();
      return;
    }

    const controller = new AbortController();
    this.inFlight.set(id, controller);
    this.handle(method, p, controller.signal)
      .then(
        (result) => {
          if (!controller.signal.aborted) this.send({ id, result });
        },
        (err: unknown) => {
          if (controller.signal.aborted) return;
          const code = err instanceof RpcError ? err.code : -32603;
          this.send({ id, error: { code, message: err instanceof Error ? err.message : String(err) } });
        },
      )
      .finally(() => this.inFlight.delete(id));
  }

  private async handle(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion;
        const protocolVersion = typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
        return {
          protocolVersion,
          capabilities: { tools: {}, prompts: {} },
          serverInfo: this.info,
          ...(this.instructions ? { instructions: this.instructions } : {}),
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: [...this.tools.values()].map((t) => t.listing) };
      case "tools/call":
        return this.callTool(params, signal);
      case "prompts/list":
        return { prompts: [...this.prompts.values()].map((p) => p.listing) };
      case "prompts/get": {
        const prompt = this.prompts.get(String(params.name));
        if (!prompt) throw new RpcError(INVALID_PARAMS, `Prompt ${String(params.name)} not found`);
        const parsed = prompt.schema.safeParse(params.arguments ?? {});
        if (!parsed.success) throw new RpcError(INVALID_PARAMS, `Invalid arguments for prompt ${String(params.name)}: ${describeIssues(parsed.error)}`);
        return prompt.get(parsed.data as never);
      }
      default:
        throw new RpcError(METHOD_NOT_FOUND, "Method not found");
    }
  }

  private async callTool(params: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
    const name = String(params.name);
    const tool = this.tools.get(name);
    if (!tool) return { content: [{ type: "text", text: `Tool ${name} not found` }], isError: true };
    const parsed = tool.schema.safeParse(params.arguments ?? {});
    if (!parsed.success) {
      // a tool error, not a protocol error, so the model sees what to fix
      return { content: [{ type: "text", text: `Invalid arguments for tool ${name}: ${describeIssues(parsed.error)}` }], isError: true };
    }
    const meta = params._meta as { progressToken?: unknown } | undefined;
    const token = meta?.progressToken;
    let count = 0;
    const progress =
      typeof token === "string" || typeof token === "number"
        ? (message: string) => {
            if (!signal.aborted) this.send({ method: "notifications/progress", params: { progressToken: token, progress: ++count, message } });
          }
        : undefined;
    return tool.run(parsed.data as never, { signal, progress });
  }
}
