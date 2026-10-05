// npm run dev:plugin — a throwaway plugin that runs this checkout, without clashing with the real one.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("writes a dev plugin that runs the local build under its own name", () => {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "voice-devplugin-")), "plugin");
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "dev-plugin.mjs"), "--no-build", "--dir", dir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /claude --plugin-dir/);

  const plugin = JSON.parse(readFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(plugin.name, "mac-voice-mcp-dev");
  assert.deepEqual(plugin.mcpServers["voice-mcp"], { command: process.execPath, args: [path.join(ROOT, "dist", "index.js")] });

  const talk = readFileSync(path.join(dir, "skills", "talk", "SKILL.md"), "utf8");
  assert.match(talk, /mcp__plugin_mac-voice-mcp-dev_voice-mcp__speak_and_listen/);
  assert.match(talk, /\/mac-voice-mcp-dev:talk/);
  assert.doesNotMatch(talk, /mcp__plugin_mac-voice-mcp_voice-mcp|\/mac-voice-mcp:/);
  for (const f of ["hooks.json", "voice-mode.mjs", "voice-mode-lib.mjs"]) assert.ok(existsSync(path.join(dir, "hooks", f)), f);
});
