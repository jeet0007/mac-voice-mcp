#!/usr/bin/env node
// Claude Code hook entry point: reads the event from stdin and applies hooks/voice-mode-lib.mjs.
// Any unexpected problem allows Claude to carry on: this hook must never trap it.
import { handle } from "./voice-mode-lib.mjs";

let result = { exitCode: 0 };
try {
  process.stdin.setEncoding("utf8");
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  if (raw.trim()) result = handle(JSON.parse(raw));
} catch {
  /* never block on our own mistakes */
}
if (result.stderr) process.stderr.write(result.stderr + "\n");
// Context for the tool result Claude reads next. Unlike exit code 2, Claude Code doesn't show it as an error.
if (result.context) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: result.context } }) + "\n");
}
process.exit(result.exitCode);
