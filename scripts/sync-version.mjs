#!/usr/bin/env node
// Runs from `npm version <patch|minor|major>` (the "version" lifecycle script): copies the new
// package.json version into server.json and the Claude Code plugin, so one command bumps everything.
import { readFileSync, writeFileSync } from "node:fs";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const write = (p, data) => writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
const { name, version } = read("package.json");

// Refuse to tag a release the changelog doesn't describe (npm version then stops before committing).
const heading = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m");
if (!heading.test(readFileSync("CHANGELOG.md", "utf8"))) {
  console.error(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section. Add one (move the Unreleased notes into it), then run npm version again.`);
  process.exit(1);
}

const server = read("server.json");
server.version = version;
for (const pkg of server.packages ?? []) if (pkg.identifier === name) pkg.version = version;
write("server.json", server);

const plugin = read(".claude-plugin/plugin.json");
plugin.version = version;
for (const cfg of Object.values(plugin.mcpServers ?? {})) {
  cfg.args = (cfg.args ?? []).map((a) => (a === name || a.startsWith(`${name}@`) ? `${name}@${version}` : a));
}
write(".claude-plugin/plugin.json", plugin);

console.log(`server.json and .claude-plugin/plugin.json → ${version}`);
