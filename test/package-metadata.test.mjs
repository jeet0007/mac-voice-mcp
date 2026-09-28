// Release metadata and plugin files stay in sync with the code, so a release can't ship mismatched.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SPEECH_RULES } from "../dist/texts.js";

const json = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));
const text = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const pkg = json("package.json");

test("package.json, package-lock.json, server.json and the plugin all carry the same version", () => {
  const lock = json("package-lock.json");
  const server = json("server.json");
  const plugin = json(".claude-plugin/plugin.json");
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages[0].version, pkg.version);
  assert.equal(server.name, pkg.mcpName);
  assert.equal(plugin.version, pkg.version);
  // The plugin runs exactly the npm release it was published with.
  assert.deepEqual(plugin.mcpServers["voice-mcp"].args, ["-y", `${pkg.name}@${pkg.version}`]);
});

test("the changelog has an entry for this version", () => {
  assert.match(text("CHANGELOG.md"), new RegExp(`^## \\[${pkg.version.replace(/\./g, "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m"));
});

test("plugin skills use the plugin's real tool names and the current speaking rules", () => {
  const talk = text("skills/talk/SKILL.md");
  for (const line of SPEECH_RULES.split("\n")) assert.ok(talk.includes(line), `skills/talk is missing: ${line}`);
  for (const skill of ["talk", "setup"]) {
    const body = text(`skills/${skill}/SKILL.md`);
    for (const tool of body.match(/mcp__\S+/g) ?? []) {
      assert.match(tool, /^mcp__plugin_mac-voice-mcp_voice-mcp__(speak_and_listen|voice_setup)$/, `${skill}: ${tool}`);
    }
  }
});
