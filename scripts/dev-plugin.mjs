#!/usr/bin/env node
/**
 * npm run dev:plugin — try this checkout in Claude Code as a plugin, safely.
 *
 * Builds the project and writes a throwaway plugin, "mac-voice-mcp-dev", that runs THIS checkout's
 * dist/index.js with node (no npx, no npm download) and carries its current skills and hooks.
 * Its own name means it never clashes with the installed mac-voice-mcp plugin, and it works from
 * any folder — including this repo, where `npx mac-voice-mcp@<this version>` can't run.
 *
 *   npm run dev:plugin [-- --dir <path>] [-- --no-build] [-- --debug]
 *   claude --plugin-dir <printed path>
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "mac-voice-mcp";
const DEV = `${NAME}-dev`;
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const option = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);

const cache =
  process.env.VOICE_MCP_CACHE_DIR?.trim() || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), NAME);
const dir = path.resolve(option("--dir") ?? path.join(cache, "dev-plugin"));
const entry = path.join(ROOT, "dist", "index.js");

if (!flag("--no-build")) {
  const r = spawnSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
if (!existsSync(entry)) {
  console.error(`No build at ${entry} — run npm run build first.`);
  process.exit(1);
}

// Fresh copy every time, so the dev plugin always matches the checkout.
rmSync(dir, { recursive: true, force: true });
mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const plugin = JSON.parse(readFileSync(path.join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
plugin.name = DEV;
plugin.displayName = `${plugin.displayName ?? "Mac Voice"} (dev)`;
plugin.version = `${pkg.version}-dev`;
plugin.description = `Development build of ${NAME} from ${ROOT}`;
plugin.mcpServers = {
  "voice-mcp": {
    command: process.execPath,
    args: [entry],
    ...(flag("--debug") ? { env: { VOICE_MCP_DEBUG: "1" } } : {}),
  },
};
writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify(plugin, null, 2) + "\n");

// Skills: same content, pointed at the dev plugin's command and tool names.
const rename = (text) =>
  text.replaceAll(`mcp__plugin_${NAME}_`, `mcp__plugin_${DEV}_`).replace(new RegExp(`/${NAME}:`, "g"), `/${DEV}:`);
for (const skill of readdirSync(path.join(ROOT, "skills"))) {
  const src = path.join(ROOT, "skills", skill, "SKILL.md");
  if (!existsSync(src)) continue;
  mkdirSync(path.join(dir, "skills", skill), { recursive: true });
  writeFileSync(path.join(dir, "skills", skill, "SKILL.md"), rename(readFileSync(src, "utf8")));
}
cpSync(path.join(ROOT, "hooks"), path.join(dir, "hooks"), { recursive: true });

console.error(`
Dev plugin ready: ${dir}
  server  ${process.execPath} ${entry}

Start Claude Code with it (any folder works):
  claude --plugin-dir "${dir}"

Then:
  /mcp                     should list plugin:${DEV}:voice-mcp as connected
  /${DEV}:setup     check the setup
  /${DEV}:talk      start a voice conversation

Your installed ${NAME} plugin is untouched. To avoid two voice tools in that session,
disable ${NAME} in /plugin first. Re-run this after changing code, then restart claude.
`);
